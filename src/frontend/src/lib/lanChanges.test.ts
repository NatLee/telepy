import { test } from "node:test";
import assert from "node:assert/strict";
import { changeCounts, changeGroups, hostChange, isOwn, scanAge, splitOwn, STALE_DAYS } from "./lanChanges.ts";
import { flattenHosts, hostMatches } from "./lanHosts.ts";

const h = (address: string, more: Record<string, unknown> = {}) => ({ address, ...more });

test("the device's own row is split off; the gateway leads and hosts not seen go last", () => {
    const hosts = [h("10.0.0.5"), h("10.0.0.9", { missing: true }), h("localhost", { own: true, source: "self" }), h("10.0.0.1", { gateway: true }), h("10.0.0.7")];
    const { own, lan } = splitOwn(hosts);
    assert.equal(own?.address, "localhost");
    assert.deepEqual(lan.map((x) => x.address), ["10.0.0.1", "10.0.0.5", "10.0.0.7", "10.0.0.9"]);
    assert.equal(splitOwn([h("10.0.0.5")]).own, null);
    assert.ok(isOwn({ source: "self" }));
    assert.ok(!isOwn({ source: "scan" }));
});

test("each host's change: not seen wins, then new, then ports", () => {
    assert.equal(hostChange(h("a", { missing: true, since_last: { new: true, opened: [], closed: [] } })), "missing");
    assert.equal(hostChange(h("a", { since_last: { new: true, opened: [80], closed: [] } })), "new");
    assert.equal(hostChange(h("a", { since_last: { new: false, opened: [], closed: [22] } })), "ports");
    assert.equal(hostChange(h("a", { since_last: { new: false, opened: [], closed: [] } })), null);
    assert.equal(hostChange(h("a")), null);
});

test("change counts and groups pair addresses with hosts", () => {
    const c = { new: ["10.0.0.9"], gone: ["10.0.0.3"], changed: [{ address: "10.0.0.2", opened: [443], closed: [80] }] };
    assert.deepEqual(changeCounts(c), { new: 1, gone: 1, changed: 1, total: 3 });
    assert.equal(changeCounts(null), null);
    const g = changeGroups(c, [{ address: "10.0.0.9", id: 1 }, { address: "10.0.0.2", id: 2 }]);
    assert.equal(g.new[0].host?.id, 1);
    assert.equal(g.gone[0].host, null, "a host deleted since keeps its address");
    assert.deepEqual(g.changed[0], { address: "10.0.0.2", opened: [443], closed: [80], host: { address: "10.0.0.2", id: 2 } });
});

test("scan age and when it counts as out of date", () => {
    const now = Date.parse("2026-11-10T00:00:00Z");
    assert.deepEqual(scanAge("2026-11-09T00:00:00Z", now), { ms: 86_400_000, days: 1, stale: false });
    assert.equal(scanAge(`2026-11-0${10 - STALE_DAYS}T00:00:00Z`, now)?.stale, true);
    assert.equal(scanAge(null, now), null);
    assert.equal(scanAge("nonsense", now), null);
});

test("is: search keys", () => {
    const base = { id: 1, tunnel_id: 1, hostname: null, label: null, mac: null, vendor: null, ssh_banner: null, open_ports: [], ssh_port: 22, last_seen: null };
    const devices = [{ id: 1, name: "office", hosts: [
        { ...base, id: 1, address: "localhost", own: true, source: "self" as const },
        { ...base, id: 2, address: "10.0.0.1", gateway: true },
        { ...base, id: 3, address: "10.0.0.9", since_last: { new: true, opened: [], closed: [] } },
        { ...base, id: 4, address: "10.0.0.3", missing: true },
        { ...base, id: 5, address: "10.0.0.2", since_last: { new: false, opened: [443], closed: [] } },
    ] }];
    const rows = flattenHosts(devices);
    const find = (q: string) => rows.filter((r) => hostMatches(r, [q])).map((r) => r.host.address);
    assert.deepEqual(find("is:self"), ["localhost"]);
    assert.deepEqual(find("is:gateway"), ["10.0.0.1"]);
    assert.deepEqual(find("is:new"), ["10.0.0.9"]);
    assert.deepEqual(find("is:missing"), ["10.0.0.3"]);
    assert.deepEqual(find("is:changed"), ["10.0.0.2"]);
    assert.deepEqual(find("is:nonsense"), []);
});
