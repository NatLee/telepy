// node --test（Node 23 會直接拿掉型別）。/ Run with `npm test` (Node strips the types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareTunnels, matchTunnel, parseQuery, pinnedFirst, tokenize, type MatchContext } from "./tunnelQuery.ts";
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

test("labels (tag: alias) and pins", () => {
    const t = tunnel({ labels: ["env=prod", "home"], pinned: true });
    assert.ok(match("label:home", t));
    assert.ok(match("tag:env=prod", t), "tag is an alias");
    assert.ok(!match("label:hom", t), "labels match exactly");
    assert.ok(match("hom", t), "free text matches inside labels");
    assert.ok(match("pinned:yes", t));
    assert.ok(match("pinned:no", tunnel({})));
    assert.deepEqual(parseQuery("pinned:maybe").invalid, ["pinned:maybe"]);
    const list = [tunnel({ id: 1 }), tunnel({ id: 2, pinned: true })];
    assert.deepEqual(list.sort(pinnedFirst).map((x) => x.id), [2, 1]);
});

test("group matches my group's name, none = ungrouped, and free text finds it", () => {
    const t = tunnel({});
    const inGroup = (q: string, group: string | null) => matchTunnel(t, parseQuery(q), { health: "online", now: NOW, group });
    assert.ok(inGroup("group:prod", "Prod"), "case-insensitive");
    assert.ok(inGroup(`group:"home lab"`, "Home lab"), "quoted names with spaces");
    assert.ok(!inGroup("group:prod", "Production"), "the whole name, not a prefix");
    assert.ok(inGroup("group:none", null));
    assert.ok(!inGroup("group:none", "Prod"));
    assert.ok(inGroup("-group:none", "Prod"));
    assert.ok(inGroup("prod", "Production"), "free text searches the group name too");
    assert.deepEqual(parseQuery("group:").invalid, ["group:"]);
});

test("label also matches the labels of the tunnel's group", () => {
    const t = tunnel({ labels: ["web"] });
    const m = (q: string, groupLabels?: string[]) => matchTunnel(t, parseQuery(q), { health: "online", now: NOW, group: "Prod", groupLabels });
    assert.ok(m("label:web"), "its own label");
    assert.ok(m("label:env=prod", ["env=prod"]), "its group's label");
    assert.ok(!m("label:env=prod"), "no group labels");
    assert.ok(!m("-label:env=prod", ["env=prod"]));
    assert.ok(m("env=prod", ["env=prod"]), "free text finds group labels");
});

test("warn: device warnings", () => {
    const facts = (...kinds: string[]) => ({ ip: "1.2.3.4", live: true, connected_at: "2026-10-23T10:00:00Z", last_seen_at: null, facts: { warnings: kinds.map((kind) => ({ kind, detail: "" })) } });
    const full = tunnel({ endpoint: facts("disk", "reboot") });
    const fine = tunnel({ endpoint: facts() });
    assert.ok(match("warn:disk", full));
    assert.ok(match("warn:memory,reboot", full));
    assert.ok(!match("warn:load", full));
    assert.ok(match("warn:any", full));
    assert.ok(!match("warn:any", fine));
    assert.ok(match("-warn:any", fine));
    assert.ok(!match("warn:any", tunnel({ endpoint: null })), "hidden endpoint = no warnings");
    assert.deepEqual(parseQuery("warn:cpu").invalid, ["warn:cpu"]);
});

test("make me a sandwich (xkcd 149)", () => {
    assert.equal(parseQuery("make me a sandwich").reply, "makeItYourself");
    assert.equal(parseQuery("  sudo make me a sandwich!").reply, "okay");
    assert.equal(parseQuery("SUDO Make Me A Sandwich.").reply, "okay");
    assert.deepEqual(parseQuery("sudo make me a sandwich").text, []);
    // 只認整句；放在別的詞旁邊就是一般文字。/ Only the whole query counts.
    assert.equal(parseQuery("sandwich").reply, undefined);
    assert.equal(parseQuery("sudo make me a sandwich status:online").reply, undefined);
});
