// node --test（Node 23 會直接拿掉型別）。/ Run with `npm test` (Node strips the types).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    accountChoices,
    deviceProgress,
    groupNameProblem,
    groupOf,
    groupSections,
    keyGroupReach,
    moveId,
    normalizeGroupName,
    placedAccounts,
    unionAccounts,
} from "./groups.ts";
import type { KeyGroup, KeyGroupGrant, TunnelGroup } from "../types/groups";

const tg = (id: number, name: string, position: number, tunnel_ids: number[]): TunnelGroup => ({ id, name, position, tunnel_ids, created_at: "" });
const grant = (id: number, over: Partial<KeyGroupGrant>): KeyGroupGrant => ({ id, tunnel: null, tunnel_group: null, accounts: null, created_at: "", ...over });

test("names are normalised and checked like the backend", () => {
    assert.equal(normalizeGroupName("  Prod   web "), "Prod web");
    const existing = [{ id: 1, name: "Prod" }];
    assert.equal(groupNameProblem("   ", existing), "empty");
    assert.equal(groupNameProblem("prod", existing), "taken", "case-insensitive");
    assert.equal(groupNameProblem("PROD", existing, 1), null, "its own name is fine");
    assert.equal(groupNameProblem("x".repeat(49), existing), "tooLong");
    assert.equal(groupNameProblem("字".repeat(48), existing), null, "characters, not bytes");
});

test("sections follow my order and put ungrouped last", () => {
    const groups = [tg(1, "B", 1, [2]), tg(2, "A", 0, [1, 4])];
    const all = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    assert.deepEqual(groupOf(groups).get(4), 2);
    const s = groupSections(all, all, groups, false);
    assert.deepEqual(s.map((x) => [x.group?.name ?? null, x.items.map((i) => i.id), x.total]), [["A", [1, 4], 2], ["B", [2], 1], [null, [3], 1]]);
    // 篩選中：沒有符合的段拿掉；平常空的群組留著、空的「未分組」拿掉。/ Filtering hides empty sections.
    const visible = [{ id: 3 }];
    assert.deepEqual(groupSections(visible, all, groups, true).map((x) => x.group?.name ?? null), [null]);
    const allGrouped = [{ id: 1 }, { id: 2 }, { id: 4 }];
    assert.deepEqual(groupSections(allGrouped, allGrouped, [...groups, tg(3, "Empty", 2, [])], false).map((x) => x.group?.name ?? null), ["A", "B", "Empty"]);
});

test("moving an id stops at the ends", () => {
    assert.deepEqual(moveId([1, 2, 3], 2, -1), [2, 1, 3]);
    assert.deepEqual(moveId([1, 2, 3], 3, 1), [1, 2, 3]);
    assert.deepEqual(moveId([1, 2, 3], 9, 1), [1, 2, 3]);
});

test("a key group reaches tunnels through both kinds of grants", () => {
    const groups = [tg(10, "Prod", 0, [1, 2])];
    const kg: KeyGroup = {
        id: 5,
        name: "Laptops",
        key_ids: [7],
        created_at: "",
        grants: [grant(1, { tunnel_group: { id: 10, name: "Prod" }, accounts: ["deploy"] }), grant(2, { tunnel: { id: 2, name: "two" }, accounts: ["ubuntu"] }), grant(3, { tunnel: { id: 3, name: "three" } })],
    };
    const reach = keyGroupReach(kg, groups);
    assert.deepEqual(reach.map((r) => [r.tunnelId, r.via.map((g) => g.id), r.accounts]), [
        [1, [1], ["deploy"]],
        [2, [1, 2], ["deploy", "ubuntu"]],
        [3, [3], null],
    ]);
    // 通道群組被刪 / 找不到：那筆授予不碰任何通道。/ A missing tunnel group reaches nothing.
    assert.deepEqual(keyGroupReach(kg, []).map((r) => r.tunnelId), [2, 3]);
});

test("account choices and placement", () => {
    assert.deepEqual(unionAccounts([["b"], ["a", "b"]]), ["a", "b"]);
    assert.equal(unionAccounts([["a"], null]), null);
    const devices = [{ tunnel_id: 1, accounts: ["ubuntu", "deploy"] }, { tunnel_id: 2, accounts: ["root"] }, { tunnel_id: 3, accounts: ["x"] }];
    assert.deepEqual(accountChoices([1, 2], devices), ["deploy", "root", "ubuntu"]);
    assert.deepEqual(placedAccounts(["ubuntu", "deploy"], null), ["ubuntu", "deploy"]);
    assert.deepEqual(placedAccounts(["ubuntu", "deploy"], ["deploy", "root"]), ["deploy"]);
});

test("device progress counts only the group's keys", () => {
    const device = {
        keys: [
            { user_key_id: 1, targets: [{ status: "installed" }, { status: "pending" }] },
            { user_key_id: 2, targets: [{ status: "error" }] },
            { user_key_id: 9, targets: [{ status: "installed" }] },
        ],
    };
    assert.deepEqual(deviceProgress(device, [1, 2]), { installed: 1, pending: 1, error: 1 });
    assert.deepEqual(deviceProgress(undefined, [1]), { installed: 0, pending: 0, error: 0 });
});
