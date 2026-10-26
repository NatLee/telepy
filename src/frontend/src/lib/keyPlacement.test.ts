import { test } from "node:test";
import assert from "node:assert/strict";
import {
    ADMIN_FILE,
    EXAMPLE_ACCOUNTS,
    EXAMPLE_ALLOWED,
    EXAMPLE_CHOSEN,
    USER_FILE,
    accountsFromDevice,
    chosenCount,
    placeKey,
    summarizePlacement,
    toggleChosen,
} from "./keyPlacement.ts";

test("placement = allowed ∩ chosen, with the ceiling winning", () => {
    const p = placeKey(EXAMPLE_ACCOUNTS, EXAMPLE_ALLOWED, EXAMPLE_CHOSEN);
    assert.deepEqual(
        p.map((x) => [x.account.username, x.state]),
        [
            ["ubuntu", "placed"],
            ["root", "notAllowed"],
            ["nat", "unchosen"],
        ]
    );
    // null 選擇 = 全選；"all" = 擁有者本人。/ A null choice = every allowed account; "all" = the owner.
    assert.deepEqual(placeKey(EXAMPLE_ACCOUNTS, "all", null).map((x) => x.state), ["placed", "placed", "placed"]);
    // 選了沒權限的帳號：還是不裝（之後放寬權限才生效）。/ Choosing an account outside the ceiling places nothing there.
    assert.deepEqual(placeKey(EXAMPLE_ACCOUNTS, [1], [1, 2]).map((x) => x.state), ["placed", "notAllowed", "notAllowed"]);
});

test("summary counts states and distinct files (the admin file is shared)", () => {
    const s = summarizePlacement(placeKey(EXAMPLE_ACCOUNTS, "all", null));
    assert.deepEqual([s.placed, s.unchosen, s.notAllowed], [3, 0, 0]);
    assert.deepEqual(s.files, [`ubuntu:${USER_FILE}`, `root:${USER_FILE}`, ADMIN_FILE]);
    const two = summarizePlacement(placeKey([...EXAMPLE_ACCOUNTS, { id: 4, username: "ops", file: ADMIN_FILE, windowsAdmin: true }], "all", null));
    assert.equal(two.files.length, 3, "two admins share one file");
});

test("device data → diagram accounts, allowed accounts missing from the view are filled in", () => {
    const view = [
        { username: "nat", file: ADMIN_FILE, windows_admin: true, checked_at: null, exists: null, error: null, rows: [] },
        { username: "guest", file: USER_FILE, windows_admin: false, checked_at: null, exists: null, error: null, rows: [] },
    ];
    const allowed = [
        { id: 7, username: "guest" },
        { id: 9, username: "pi" },
    ];
    const a = accountsFromDevice(view, allowed);
    assert.deepEqual(
        a.map((x) => [x.username, x.id, x.windowsAdmin]),
        [
            ["nat", null, true],
            ["guest", 7, false],
            ["pi", 9, false],
        ]
    );
});

test("picker helpers: counts and toggling", () => {
    const allowed = [
        { id: 1, username: "ubuntu" },
        { id: 2, username: "root" },
        { id: 3, username: "nat" },
    ];
    assert.deepEqual(chosenCount(null, allowed), { chosen: 3, total: 3, all: true });
    assert.deepEqual(chosenCount([1, 99], allowed), { chosen: 1, total: 3, all: false });
    // 全選狀態取消一個 → 其餘兩個。/ Unticking one from "all" leaves the other two.
    assert.deepEqual(toggleChosen(null, allowed, 2, false), [1, 3]);
    // 勾回最後一個 → 回到 null（全部）。/ Ticking the last one back = all (null).
    assert.equal(toggleChosen([1, 3], allowed, 2, true), null);
    // 不能取消到零個。/ Never down to zero.
    assert.deepEqual(toggleChosen([1], allowed, 1, false), [1]);
    // 保留 allowed 的順序、丟掉不認識的 id。/ Keeps the allowed order and drops unknown ids.
    assert.deepEqual(toggleChosen([3, 99], allowed, 1, true), [1, 3]);
});
