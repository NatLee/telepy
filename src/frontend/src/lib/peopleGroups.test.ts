import { test } from "node:test";
import assert from "node:assert/strict";
import {
    filterNamedGroups,
    impactEmpty,
    impactSummary,
    memberDiff,
    nameProblem,
    orgSharing,
    parseImpact,
    parsePersonalGroups,
    ruleCounts,
    scimManaged,
    tunnelList,
} from "./peopleGroups.ts";

test("organization group sharing is read with safe defaults", () => {
    assert.deepEqual(orgSharing({ id: 1 }), { shareable: false, shares: [] }, "an older backend = not shareable");
    const s = orgSharing({
        shareable: true,
        shares: [{ id: 7, tunnel_id: 3, tunnel_name: "web-1", owner: "alice", permission_type: "boss", through: 4, expires_at: null }, { tunnel_id: 9 }],
    });
    assert.equal(s.shareable, true);
    assert.equal(s.shares.length, 1);
    assert.equal(s.shares[0].permission_type, "view", "unknown permissions read as view");
    assert.equal(s.shares[0].through, 4);
    assert.equal(orgSharing(null).shareable, false);
});

test("SCIM groups and feature rules", () => {
    assert.equal(scimManaged("Managed by Okta (SCIM)"), true);
    assert.equal(scimManaged("Contractors"), false);
    assert.deepEqual(ruleCounts({ terminal: true, files: false, network: false, x: undefined }), { allow: 1, deny: 2 });
    assert.deepEqual(ruleCounts(undefined), { allow: 0, deny: 0 });
});

test("personal groups parse defensively", () => {
    const l = parsePersonalGroups({
        groups: [
            { id: 12, name: "Ops team", members: [5, "x", 9], member_names: ["bob", 3, "carol"], shares: [{ id: 8, tunnel_id: 3, tunnel_name: "web-1", permission_type: "edit", active: false }, { tunnel_id: 4 }] },
            { name: "no id" },
        ],
        users: [{ id: 5, username: "bob" }, { username: "nobody" }],
        created_id: 12,
    });
    assert.equal(l.groups.length, 1);
    assert.deepEqual(l.groups[0].members, [5, 9]);
    assert.deepEqual(l.groups[0].member_names, ["bob", "carol"]);
    assert.equal(l.groups[0].shares.length, 1);
    assert.equal(l.groups[0].shares[0].active, false);
    assert.deepEqual(l.users, [{ id: 5, username: "bob", email: "" }]);
    assert.equal(l.limit, 50, "missing limits fall back");
    assert.equal(l.max_members, 200);
    assert.equal(l.created_id, 12);
    assert.equal(l.can_share, true, "an older backend without the field = may share");
    assert.equal(parsePersonalGroups({ can_share: false }).can_share, false);
    // 已經看不到的通道沒有名字：顯示編號。/ A tunnel you can no longer see has no name: shown by id.
    const hidden = parsePersonalGroups({ groups: [{ id: 1, shares: [{ id: 2, tunnel_id: 7, tunnel_name: null }] }] }).groups[0].shares[0];
    assert.deepEqual([hidden.tunnel_name, hidden.hidden], ["#7", true]);
    assert.equal(l.groups[0].shares[0].hidden, false);
    // 我所在的群組：種類只認 personal / org，主人只給字串，通道的 through 只認 true。
    // Groups I'm in: kind is personal or org, owner only a string, a tunnel's through only true.
    const m = parsePersonalGroups({
        member_of: [
            { id: 3, name: "Pals", kind: "personal", owner: "alice", tunnels: [{ id: 9, name: "web-1", permission_type: "edit", through: true }, { id: 10, through: "yes" }, { name: "x" }] },
            { id: 4, name: "Ops", kind: "weird", owner: 5 },
            { name: "no id" },
        ],
    }).member_of;
    assert.equal(m.length, 2);
    assert.deepEqual([m[0].kind, m[0].owner, m[0].tunnels.length, m[0].tunnels[0].through, m[0].tunnels[1].through, m[0].tunnels[1].name], ["personal", "alice", 2, true, false, "#10"]);
    assert.deepEqual([m[1].kind, m[1].owner, m[1].tunnels], ["org", null, []]);
    assert.deepEqual(parsePersonalGroups(undefined).member_of, []);
    assert.deepEqual(parsePersonalGroups(undefined).groups, []);
});

test("search, names and member changes", () => {
    const groups = [
        { name: "Ops team", description: "", member_names: ["bob"] },
        { name: "Design", description: "UI people", member_names: ["carol"] },
    ];
    assert.deepEqual(filterNamedGroups(groups, "carol ui").map((g) => g.name), ["Design"]);
    assert.equal(filterNamedGroups(groups, "  ").length, 2);
    assert.equal(nameProblem("  "), "empty");
    assert.equal(nameProblem("x".repeat(65)), "long");
    assert.equal(nameProblem("ok"), null);
    assert.deepEqual(memberDiff([1, 2, 3], [2, 3, 4, 5]), { added: 2, removed: 1 });
});

test("the impact preview: empty means save straight away, the summary counts tunnels once", () => {
    const empty = parseImpact({ gain: [], lose: [{ user_id: 1, username: "x", tunnels: [] }], shares: 0 });
    assert.equal(impactEmpty(empty), true, "someone with no tunnels listed gains or loses nothing");
    const i = parseImpact({
        gain: [{ user_id: 5, username: "bob", tunnels: [{ id: 3, name: "web-1" }] }],
        lose: [
            { user_id: 9, username: "dave", tunnels: [{ id: 3, name: "web-1" }, { id: 4, name: "db" }, { id: 5, name: "a" }, { id: 6, name: "b" }] },
            { user_id: 8, username: "carol", tunnels: [{ id: 4, name: "db" }] },
        ],
        shares: 2,
    });
    assert.equal(impactEmpty(i), false);
    assert.deepEqual(i.lose.map((p) => p.username), ["carol", "dave"], "sorted by name");
    assert.deepEqual(impactSummary(i), { gainPeople: 1, losePeople: 2, tunnels: 4, shares: 2 });
    assert.deepEqual(tunnelList(i.lose[1]), { names: ["web-1", "db", "a"], more: 1 });
    assert.equal(impactEmpty(parseImpact({ shares: 1 })), false, "a share ending is worth asking about");
    assert.deepEqual(parseImpact(null), { gain: [], lose: [], shares: 0 });
});
