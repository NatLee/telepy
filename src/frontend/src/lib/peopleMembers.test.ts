import { test } from "node:test";
import assert from "node:assert/strict";
import {
    addCandidates,
    applyDelta,
    bulkTouches,
    filterValue,
    inMembership,
    keepVisible,
    liveFilter,
    memberDelta,
    memberRows,
    membershipIndex,
    parsePaste,
    personMatches,
    pinnedItem,
    resolvePaste,
    sortGroups,
    togglePage,
    type MemberPerson,
} from "./peopleMembers.ts";

const p = (id: number, username: string, extra: Partial<MemberPerson> = {}): MemberPerson => ({ id, username, email: `${username}@example.com`, ...extra });
const people = [p(1, "alice", { first_name: "Alice", last_name: "Wong" }), p(2, "alfred"), p(3, "bob", { email: "BOB@corp.test" }), p(4, "carol"), p(5, "al")];

test("personMatches: every word, any field, case-insensitive", () => {
    assert.ok(personMatches(people[0], "WONG ali"));
    assert.ok(personMatches(people[2], "corp.test"));
    assert.ok(!personMatches(people[0], "alice bob"));
    assert.ok(personMatches(people[3], "   "));
});

test("addCandidates: exact first, then prefix, members left out, capped", () => {
    assert.deepEqual(addCandidates(people, "al", new Set()).map((x) => x.username), ["al", "alfred", "alice"]);
    assert.deepEqual(addCandidates(people, "al", new Set([5, 2])).map((x) => x.username), ["alice"]);
    assert.deepEqual(addCandidates(people, "a", new Set(), 2).length, 2);
    assert.deepEqual(addCandidates(people, "", new Set()), []);
    // email 完全相同也排第一。/ An exact email counts as exact.
    assert.equal(addCandidates(people, "bob@corp.test", new Set())[0].username, "bob");
});

test("parsePaste: commas, spaces, newlines, brackets, duplicates", () => {
    assert.deepEqual(parsePaste("alice, bob\ncarol;  Alice\n\n<dave@x.io> \"eve\""), ["alice", "bob", "carol", "dave@x.io", "eve"]);
    assert.deepEqual(parsePaste("  \n , "), []);
});

test("resolvePaste: found / already in / missing", () => {
    const r = resolvePaste(["ALICE", "bob@corp.test", "carol", "zed", "alice@example.com"], people, new Set([4]));
    assert.deepEqual(r.found, [1, 3]);
    assert.deepEqual(r.already, ["carol"]);
    assert.deepEqual(r.missing, ["zed"]);
});

test("memberDelta and applyDelta", () => {
    assert.deepEqual(memberDelta([1, 2, 3], [2, 3, 4, 5]), { add: [4, 5], remove: [1] });
    assert.deepEqual(memberDelta([1], [1]), { add: [], remove: [] });
    assert.deepEqual(applyDelta([1, 2, 3], { add: [3, 4], remove: [1] }), [2, 3, 4]);
    assert.deepEqual(applyDelta([1, 2], { add: [2] }), [1, 2]);
    assert.deepEqual(applyDelta([1, 2], { remove: [2, 9] }), [1]);
});

test("memberRows: additions first, removed kept and marked, unknown ids", () => {
    const byId = new Map(people.map((x) => [x.id, x]));
    const rows = memberRows([4, 1, 99], [1, 99, 3], byId);
    assert.deepEqual(rows.map((r) => [r.id, r.state]), [[3, "added"], [99, "kept"], [1, "kept"], [4, "removed"]]);
    assert.equal(rows[1].person, null);
});

test("sortGroups by name and by members", () => {
    const g = [
        { id: 1, name: "beta", members: [1] },
        { id: 2, name: "Alpha", members: [1, 2, 3] },
        { id: 3, name: "gamma", members: [1, 2, 3] },
    ];
    assert.deepEqual(sortGroups(g, "name").map((x) => x.id), [2, 1, 3]);
    assert.deepEqual(sortGroups(g, "members").map((x) => x.id), [2, 3, 1]);
});

test("pinnedItem: only when on another page", () => {
    const all = [{ id: 1 }, { id: 2 }, { id: 3 }];
    assert.equal(pinnedItem(all, all.slice(0, 2), 2), null);
    assert.deepEqual(pinnedItem(all, all.slice(0, 2), 3), { id: 3 });
    assert.equal(pinnedItem(all, all.slice(0, 2), 9), null);
    assert.equal(pinnedItem(all, all, null), null);
});

test("membership index and filters", () => {
    const idx = membershipIndex([{ id: 10, members: [1, 2] }, { id: 11, members: [2] }], [{ id: 20, members: [3] }]);
    assert.deepEqual(idx.get(2), { roles: [10, 11], groups: [] });
    assert.ok(inMembership(idx.get(1), 10, "none"));
    assert.ok(!inMembership(idx.get(1), 11, "any"));
    assert.ok(inMembership(idx.get(4), "none", "none"));
    assert.ok(inMembership(idx.get(3), "none", 20));
    assert.equal(filterValue("none"), "none");
    assert.equal(filterValue("12"), 12);
    assert.equal(filterValue("x"), "any");
    assert.equal(filterValue("-3"), "any");
    assert.equal(liveFilter(12, [1, 2]), "any");
    assert.equal(liveFilter(2, [1, 2]), 2);
    assert.equal(liveFilter("none", []), "none");
});

test("selection helpers", () => {
    assert.deepEqual([...togglePage(new Set([1]), [1, 2])].sort(), [1, 2]);
    assert.deepEqual([...togglePage(new Set([1, 2, 5]), [1, 2])], [5]);
    assert.deepEqual([...keepVisible(new Set([1, 2, 3]), [2, 3, 4])], [2, 3]);
    assert.deepEqual(bulkTouches([1, 2], [2, 3], "add"), [3]);
    assert.deepEqual(bulkTouches([1, 2], [2, 3], "remove"), [2]);
});
