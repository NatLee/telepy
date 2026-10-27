import { test } from "node:test";
import assert from "node:assert/strict";
import { accountCounts, matchesAccount, sortAccounts, type TargetAccount } from "./targetUsers.ts";

const list: TargetAccount[] = [
    { id: 1, username: "ubuntu", created_by: "alice", shared_with: 2 },
    { id: 2, username: "root", created_by: "alice", shared_with: 0 },
    { id: 3, username: "backup", created_by: "erin", shared_with: 1 },
];

test("the default account comes first, the rest by name", () => {
    assert.deepEqual(sortAccounts(list, 2).map((a) => a.username), ["root", "backup", "ubuntu"]);
    assert.deepEqual(sortAccounts(list, null).map((a) => a.username), ["backup", "root", "ubuntu"]);
});

test("buckets and search", () => {
    const names = (f: Parameters<typeof matchesAccount>[1], q = "") => list.filter((a) => matchesAccount(a, f, q, 2)).map((a) => a.username);
    assert.deepEqual(names("shared"), ["ubuntu", "backup"]);
    assert.deepEqual(names("unshared"), ["root"]);
    assert.deepEqual(names("default"), ["root"]);
    assert.deepEqual(names("all", "ERIN"), ["backup"], "search matches who added it too");
    assert.deepEqual(names("all", "ub"), ["ubuntu"]);
    assert.deepEqual(accountCounts(list, 2), { all: 3, shared: 2, unshared: 1, default: 1 });
    // 不是管理的人拿不到 shared_with：兩個分類都是 0。/ Without counts both buckets are empty.
    const plain = list.map((a) => ({ ...a, shared_with: null }));
    assert.deepEqual(accountCounts(plain, null), { all: 3, shared: 0, unshared: 0, default: 0 });
});
