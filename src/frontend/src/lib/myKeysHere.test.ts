// node --test（Node 23 會直接拿掉型別）。/ Run with `npm test` (Node strips the types).
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupHere, initialOrder, keySections, reachOf, reachSummary, type HereGroup, type HereKey } from "./myKeysHere.ts";

const key = (id: number, name: string, opts: Partial<HereKey> = {}): HereKey => ({ id, name, fingerprint: `SHA256:${name}`, key_type: "ED25519", in_list: false, group_id: null, via_groups: [], ...opts });
const group = (id: number, name: string, opts: Partial<HereGroup> = {}): HereGroup => ({ id, name, grant: null, via_tunnel_group: null, ...opts });

test("reach says how a key gets here", () => {
    assert.equal(reachOf(key(1, "a")), "none");
    assert.equal(reachOf(key(1, "a", { in_list: true })), "direct");
    assert.equal(reachOf(key(1, "a", { via_groups: [{ id: 3 }] })), "group");
    assert.equal(reachOf(key(1, "a", { in_list: true, via_groups: [{ id: 3 }] })), "both");
});

test("a group is here when granted directly or through a tunnel group", () => {
    assert.equal(groupHere(group(1, "g")), false);
    assert.equal(groupHere(group(1, "g", { grant: { id: 4 } })), true);
    assert.equal(groupHere(group(1, "g", { via_tunnel_group: { id: 2 } })), true);
});

const keys = [key(1, "laptop", { group_id: 10 }), key(2, "ci", { group_id: 20 }), key(3, "phone"), key(4, "desktop", { group_id: 10 }), key(5, "orphan", { group_id: 99 })];
const groups = [group(10, "Work"), group(20, "Deploy"), group(30, "Empty")];

test("sections follow the group order, keep empty groups and put ungrouped keys last", () => {
    const s = keySections(keys, groups);
    assert.deepEqual(
        s.map((x) => [x.group?.id ?? null, x.keys.map((k) => k.id), x.total]),
        [
            [10, [1, 4], 2],
            [20, [2], 1],
            [30, [], 0],
            [null, [3, 5], 2],
        ]
    );
});

test("no ungrouped section without ungrouped keys", () => {
    assert.deepEqual(
        keySections([keys[0]], groups).map((x) => x.group?.id ?? null),
        [10, 20, 30]
    );
});

test("searching a group name keeps the whole group; otherwise only matching keys", () => {
    assert.deepEqual(
        keySections(keys, groups, "work").map((x) => [x.group?.id ?? null, x.keys.map((k) => k.id)]),
        [[10, [1, 4]]]
    );
    assert.deepEqual(
        keySections(keys, groups, "desk").map((x) => [x.group?.id ?? null, x.keys.map((k) => k.id), x.total]),
        [[10, [4], 2]]
    );
    assert.deepEqual(
        keySections(keys, groups, "phone").map((x) => [x.group?.id ?? null, x.keys.map((k) => k.id)]),
        [[null, [3]]]
    );
    assert.deepEqual(keySections(keys, groups, "nothing"), []);
});

test("summary counts keys here, direct and only through a group", () => {
    const ks = [key(1, "a", { in_list: true }), key(2, "b", { via_groups: [{ id: 1 }] }), key(3, "c", { in_list: true, via_groups: [{ id: 1 }] }), key(4, "d")];
    assert.deepEqual(reachSummary(ks), { total: 4, here: 3, direct: 2, viaGroup: 1 });
});

test("initial order puts keys that are here first", () => {
    const ks = [key(1, "a"), key(2, "b", { via_groups: [{ id: 1 }] }), key(3, "c"), key(4, "d", { in_list: true })];
    assert.deepEqual(initialOrder(ks), [2, 4, 1, 3]);
});
