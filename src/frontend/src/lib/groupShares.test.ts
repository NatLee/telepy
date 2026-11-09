import { test } from "node:test";
import assert from "node:assert/strict";
import { groupShareSpots, mergeShares, memberParts, parseGroupShares, pickableGroups, sortedChoices } from "./groupShares.ts";

test("the answer is parsed defensively", () => {
    const l = parseGroupShares({
        can_manage: true,
        shares: [{ id: 3, group_id: 9, name: "ops", members: 4, member_names: ["bob", 2], through: 2, direct: 1, elsewhere: 1, owner_in: "yes", permission_type: "boss", expires_at: null, allowed_target_usernames: [{ id: 5, username: "ubuntu" }, { username: "x" }] }],
        groups: [{ id: 9, name: "ops", members: 4, shared: true }, { id: 10, name: "dev", members: 0 }, { name: "no id" }],
    });
    assert.equal(l.can_manage, true);
    assert.equal(l.shares[0].permission_type, "view", "unknown permissions read as view");
    assert.deepEqual(l.shares[0].member_names, ["bob"]);
    assert.deepEqual(l.shares[0].allowed_target_usernames, [{ id: 5, username: "ubuntu" }]);
    assert.deepEqual(pickableGroups(l).map((g) => g.name), ["dev"]);
    // 經由別的群組的人另外列出；擁有者只認 true。/ Members through another group are listed; owner_in only takes true.
    assert.deepEqual(memberParts(l.shares[0]), ["direct", "elsewhere"]);
    assert.deepEqual(memberParts({ ...l.shares[0], direct: 0, elsewhere: 0, owner_in: true }), ["owner"]);
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

test("shares carry their kind, owner, synced and paused state; old answers read as unsynced organization groups", () => {
    const l = parseGroupShares({
        shares: [
            { id: 1, name: "ops", kind: "personal", owner: "alice", mine: true, active: true },
            { id: 2, name: "eng", kind: "personal", owner: "bob", active: false, members: 3 },
            { id: 3, name: "old" },
            { id: 9, name: "okta", kind: "org", synced: true },
        ],
        groups: [
            { id: 4, name: "zeta", kind: "personal" },
            { id: 5, name: "alpha", kind: "personal" },
            { id: 6, name: "Org B", kind: "org", synced: true },
            { id: 7, name: "Org A" },
            { id: 8, name: "taken", kind: "org", shared: true },
        ],
    });
    assert.deepEqual(l.shares.map((s) => [s.kind, s.owner, s.mine, s.synced]), [
        ["personal", "alice", true, false],
        ["personal", "bob", false, false],
        ["org", null, false, false],
        ["org", null, false, true],
    ]);
    assert.equal(l.shares[2].active, true, "no field = active");
    assert.equal(l.shares[1].active, false);
    assert.deepEqual(groupShareSpots(l.shares[1]), { group: "ok", share: "failed", members: "waiting" }, "a paused share gives nothing");
    const c = sortedChoices(l);
    assert.deepEqual(c.map((g) => g.name), ["alpha", "zeta", "Org A", "Org B"], "yours first, each by name; already shared groups drop out");
    assert.deepEqual(c.map((g) => g.synced), [false, false, false, true]);
});
