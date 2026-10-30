import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketCounts, filterUsers, inBucket, userMatches, type UserRow } from "./managedUsers.ts";

const u = (username: string, extra: Partial<UserRow> = {}): UserRow => ({ username, email: `${username}@example.com`, is_active: true, is_superuser: false, mfa_enabled: false, ...extra });
const people = [
    u("admin", { is_superuser: true, mfa_enabled: true }),
    u("alice", { mfa_enabled: true }),
    u("bob"),
    u("carol", { is_active: false }),
    u("dave", { email: "dave@corp.test" }),
];

test("search matches username and email, every word", () => {
    assert.equal(userMatches(people[1], "ALI"), true);
    assert.equal(userMatches(people[4], "corp"), true);
    assert.equal(userMatches(people[4], "dave corp"), true);
    assert.equal(userMatches(people[4], "dave example"), false);
    assert.equal(userMatches(people[2], "   "), true);
});

test("buckets", () => {
    assert.equal(inBucket(people[0], "admins"), true);
    assert.equal(inBucket(people[3], "disabled"), true);
    assert.equal(inBucket(people[2], "no2fa"), true);
    assert.equal(inBucket(people[3], "no2fa"), false, "a disabled account can't sign in, so it isn't counted");
    assert.equal(inBucket(people[1], "no2fa"), false);
});

test("counts follow the search", () => {
    assert.deepEqual(bucketCounts(people, ""), { all: 5, admins: 1, disabled: 1, no2fa: 2 });
    assert.deepEqual(bucketCounts(people, "example"), { all: 4, admins: 1, disabled: 1, no2fa: 1 });
});

test("filter keeps the order", () => {
    assert.deepEqual(filterUsers(people, "", "no2fa").map((p) => p.username), ["bob", "dave"]);
    assert.deepEqual(filterUsers(people, "example", "all").map((p) => p.username), ["admin", "alice", "bob", "carol"]);
    assert.deepEqual(filterUsers(people, "corp", "admins"), []);
});
