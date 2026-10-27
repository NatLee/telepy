import { test } from "node:test";
import assert from "node:assert/strict";
import { FEATURES, featureForPath, laneFor, cellValue, deniedCount, featureKey, filterUsers, grantBody, hasFeature, overrideCount, resolveFeature, type AccessPolicy } from "./features.ts";

const policy: AccessPolicy = {
    features: FEATURES.map((f) => ({ id: f.id, default: true })),
    everyone: { remote_desktop: false },
    groups: [
        { id: 10, name: "Contractors", description: "", created_at: "", members: [1, 2], grants: { terminal: false } },
        { id: 11, name: "Desktop", description: "", created_at: "", members: [2], grants: { remote_desktop: true, terminal: true } },
    ],
    users: [
        { id: 1, username: "alice", email: "alice@example.com", is_superuser: false, is_active: true, groups: [10], grants: {} },
        { id: 2, username: "bob", email: "", is_superuser: false, is_active: true, groups: [10, 11], grants: { files: false } },
        { id: 3, username: "carol", email: "", is_superuser: false, is_active: true, groups: [], grants: { terminal: true } },
        { id: 9, username: "root", email: "", is_superuser: true, is_active: true, groups: [10], grants: {} },
    ],
};
const user = (id: number) => ({ kind: "user" as const, id });

test("users resolve like the backend: user → groups (deny wins) → everyone → default", () => {
    const a = resolveFeature(policy, user(1), "terminal");
    assert.deepEqual([a.allowed, a.from, a.groupId], [false, "group", 10]);
    const b = resolveFeature(policy, user(2), "terminal");
    assert.deepEqual([b.allowed, b.from, b.groupId], [false, "group", 10], "a deny in one group beats an allow in another");
    assert.equal(resolveFeature(policy, user(2), "remote_desktop").allowed, true, "a group allow beats everyone's deny");
    assert.equal(resolveFeature(policy, user(1), "remote_desktop").from, "everyone");
    assert.deepEqual(resolveFeature(policy, user(2), "files").from, "user");
    assert.deepEqual(resolveFeature(policy, user(3), "network").from, "default");
    const root = resolveFeature(policy, user(9), "terminal");
    assert.deepEqual([root.allowed, root.from, root.decided], [true, "superuser", -1]);
});

test("steps run default → everyone → groups → user and mark the deciding one", () => {
    const r = resolveFeature(policy, user(2), "remote_desktop");
    assert.deepEqual(r.steps.map((s) => s.layer), ["default", "everyone", "group", "group", "user"]);
    assert.deepEqual(r.steps.map((s) => s.value), [true, false, null, true, null]);
    assert.equal(r.steps[r.decided].name, "Desktop");
});

test("groups and everyone resolve to what inherit gives", () => {
    assert.equal(resolveFeature(policy, { kind: "group", id: 11 }, "files").from, "default");
    assert.equal(resolveFeature(policy, { kind: "group", id: 10 }, "remote_desktop").from, "everyone");
    assert.equal(resolveFeature(policy, { kind: "group", id: 10 }, "terminal").allowed, false);
    assert.equal(resolveFeature(policy, { kind: "everyone" }, "remote_desktop").allowed, false);
});

test("cells, counts and request bodies", () => {
    assert.equal(cellValue(policy, { kind: "group", id: 10 }, "terminal"), "deny");
    assert.equal(cellValue(policy, user(3), "terminal"), "allow");
    assert.equal(cellValue(policy, user(1), "terminal"), "inherit");
    assert.equal(deniedCount(policy, user(2)), 2, "terminal (group 10) and files (own)");
    assert.equal(overrideCount(policy, user(2)), 1);
    assert.deepEqual(grantBody({ kind: "everyone" }, "files", "deny"), { subject: "everyone", id: null, feature: "files", value: "deny" });
    assert.deepEqual(grantBody({ kind: "group", id: 4 }, "files", "inherit"), { subject: "group", id: 4, feature: "files", value: "inherit" });
});

test("the profile check: admins and older backends have everything", () => {
    assert.equal(hasFeature({ features: ["terminal"] }, "terminal"), true);
    assert.equal(hasFeature({ features: ["terminal"] }, "files"), false);
    assert.equal(hasFeature({ is_superuser: true, features: [] }, "files"), true);
    assert.equal(hasFeature({}, "files"), true);
    assert.equal(hasFeature(null, "files"), false);
    assert.equal(featureKey("mcp.connect"), "mcp");
    assert.equal(filterUsers(policy.users, "EXAMPLE").length, 1);
});

test("pages that belong to a feature", () => {
    assert.equal(featureForPath("/tunnels/terminal"), "terminal");
    assert.equal(featureForPath("/tunnels/create"), "tunnels.create");
    assert.equal(featureForPath("/tunnels/webhooks"), "webhooks.personal");
    assert.equal(featureForPath("/tunnels"), null);
    assert.equal(featureForPath("/tunnels/terminals"), null, "prefix match on whole segments");
    assert.equal(featureForPath(null), null);
});

test("lane A marks the deciding layer and what it overrode", () => {
    const lane = laneFor(resolveFeature(policy, user(2), "remote_desktop"));
    assert.equal(lane.default.state, "overridden");
    assert.equal(lane.everyone.state, "overridden");
    assert.deepEqual(lane.groups.map((g) => [g.name, g.state]), [["Contractors", "unset"], ["Desktop", "decides"]]);
    assert.equal(lane.user.state, "unset");
    assert.equal(lane.allowed, true);
    const own = laneFor(resolveFeature(policy, user(2), "files"));
    assert.equal(own.user.state, "decides");
    assert.equal(own.allowed, false);
    const root = laneFor(resolveFeature(policy, user(9), "files"));
    assert.equal(root.superuser, true);
    assert.equal(root.user.state, "unset");
});
