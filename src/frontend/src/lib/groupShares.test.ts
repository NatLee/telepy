import { test } from "node:test";
import assert from "node:assert/strict";
import { groupShareSpots, mergeShares, otherMembers, parseGroupShares, pickableGroups } from "./groupShares.ts";

test("the answer is parsed defensively", () => {
    const l = parseGroupShares({
        can_manage: true,
        shares: [{ id: 3, group_id: 9, name: "ops", members: 4, member_names: ["bob", 2], through: 2, direct: 1, permission_type: "boss", expires_at: null, allowed_target_usernames: [{ id: 5, username: "ubuntu" }, { username: "x" }] }],
        groups: [{ id: 9, name: "ops", members: 4, shared: true }, { id: 10, name: "dev", members: 0 }, { name: "no id" }],
    });
    assert.equal(l.can_manage, true);
    assert.equal(l.shares[0].permission_type, "view", "unknown permissions read as view");
    assert.deepEqual(l.shares[0].member_names, ["bob"]);
    assert.deepEqual(l.shares[0].allowed_target_usernames, [{ id: 5, username: "ubuntu" }]);
    assert.deepEqual(pickableGroups(l).map((g) => g.name), ["dev"]);
    assert.equal(otherMembers(l.shares[0]), 1, "e.g. the owner in the group");
    assert.deepEqual(parseGroupShares(null), { can_manage: false, shares: [], groups: [] });
});

test("the diagram lights up as the share fills", () => {
    assert.deepEqual(groupShareSpots(null), { group: "waiting", share: "waiting", members: "waiting" });
    const base = parseGroupShares({ shares: [{ id: 1, members: 0, through: 0, direct: 0 }] }).shares[0];
    assert.deepEqual(groupShareSpots(base), { group: "waiting", share: "ok", members: "waiting" });
    assert.deepEqual(groupShareSpots({ ...base, members: 3, through: 3 }), { group: "ok", share: "ok", members: "ok" });
});

test("several groups merge like the backend: highest permission, every account, latest end", () => {
    const a = { permission_type: "view" as const, expires_at: "2030-01-01T00:00:00Z", allowed_target_usernames: [{ id: 3, username: "a" }] };
    const b = { permission_type: "edit" as const, expires_at: "2029-01-01T00:00:00Z", allowed_target_usernames: [{ id: 4, username: "b" }] };
    assert.deepEqual(mergeShares([a, b]), { permission: "edit", expiresAt: "2030-01-01T00:00:00Z", accounts: [3, 4] });
    assert.equal(mergeShares([a, { ...b, expires_at: null }])?.expiresAt, null, "one without an end means none");
    assert.equal(mergeShares([]), null);
});
