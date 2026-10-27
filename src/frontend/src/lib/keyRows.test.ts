import { test } from "node:test";
import assert from "node:assert/strict";
import { filterAccounts, inBucket, ownerDisabledNote, splitUnplaced } from "./keyRows.ts";
import type { DeviceKeyEntry, ViewAccount, ViewRow } from "../types/keys.ts";

function row(state: ViewRow["state"], extra: Partial<ViewRow> = {}): ViewRow {
    return {
        state,
        legacy: false,
        verified: true,
        on_list: false,
        mine: false,
        user_key_id: 1,
        name: "laptop",
        owner: "bob",
        fingerprint: "SHA256:x",
        key_type: "ED25519",
        bits: null,
        comment: null,
        options: null,
        line_no: 1,
        line_count: 1,
        error: null,
        raw: null,
        accounts: null,
        ...extra,
    };
}

test("a disabled owner's rows say what happens to them", () => {
    assert.equal(ownerDisabledNote(row("removing", { owner_disabled: true })), "removing");
    assert.equal(ownerDisabledNote(row("manual", { owner_disabled: true })), "manual");
    assert.equal(ownerDisabledNote(row("unknown", { owner_disabled: true })), null);
    assert.equal(ownerDisabledNote(row("removing")), null, "active owners: nothing to say");
    assert.equal(ownerDisabledNote(row("manual", { owner_disabled: false })), null);
});

test("a hand-added key of a disabled owner needs attention", () => {
    assert.equal(inBucket(row("manual", { owner_disabled: true }), "attention", true), true);
    assert.equal(inBucket(row("manual"), "attention", true), false);
    const account = { username: "pi", file: "~/.ssh/authorized_keys", windows_admin: false, checked_at: null, exists: true, error: null, rows: [row("manual", { owner_disabled: true }), row("manual", { name: "other" })] } as ViewAccount;
    const { counts } = filterAccounts([account], "", "all", true);
    assert.deepEqual(counts, { all: 2, list: 0, other: 2, attention: 1 });
});

test("listed keys in no account are split by a disabled owner", () => {
    const entry = (id: number, targets: number, owner_disabled?: boolean) =>
        ({ user_key_id: id, targets: Array.from({ length: targets }, () => ({ username: "pi", status: "installed", error: null })), owner_disabled }) as unknown as DeviceKeyEntry;
    const { suspended, unplaced } = splitUnplaced([entry(1, 0, true), entry(2, 0), entry(3, 1), entry(4, 0, false)]);
    assert.deepEqual(suspended.map((e) => e.user_key_id), [1]);
    assert.deepEqual(unplaced.map((e) => e.user_key_id), [2, 4]);
});
