import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedUsersView } from "./sharedUsers.ts";

const rows = [
    { username: "alice", permission_type: "admin", allowed_target_usernames: [{ username: "root" }] },
    { username: "bob", permission_type: "view", via_group: { name: "ops" } },
    { username: "carol", permission_type: "view", via_group: { name: "ops" }, allowed_target_usernames: [{ username: "ubuntu" }] },
];

test("buckets split direct shares from shares through a group", () => {
    const v = sharedUsersView(rows, "", "group");
    assert.deepEqual(v.shown.map((r) => r.username), ["bob", "carol"]);
    assert.deepEqual(v.counts, { all: 3, direct: 1, group: 2 });
    assert.deepEqual(sharedUsersView(rows, "", "direct").shown.map((r) => r.username), ["alice"]);
});

test("search looks at names, the group, the permission and the accounts; counts follow it", () => {
    assert.deepEqual(sharedUsersView(rows, "ops", "all").shown.map((r) => r.username), ["bob", "carol"]);
    assert.deepEqual(sharedUsersView(rows, "ubuntu", "all").shown.map((r) => r.username), ["carol"]);
    assert.deepEqual(sharedUsersView(rows, "ADMIN root", "all").shown.map((r) => r.username), ["alice"]);
    assert.deepEqual(sharedUsersView(rows, "o", "all").counts, { all: 3, direct: 1, group: 2 });
    assert.deepEqual(sharedUsersView(rows, "carol", "direct").counts, { all: 1, direct: 0, group: 1 });
});
