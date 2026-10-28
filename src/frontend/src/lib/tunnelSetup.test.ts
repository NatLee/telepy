import { test } from "node:test";
import assert from "node:assert/strict";
import { bareKey, checkPublicKey } from "./tunnelSetup.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHAgjb8hhCbQ4/2TIVTp6pRlUi97oIezKoHrwtI5hIDU";

test("bareKey drops the comment and pasted line breaks, like the backend's comparison", () => {
    assert.equal(bareKey(`${KEY} alice@mac`), KEY);
    assert.equal(bareKey(`  ssh-ed25519\n  AAAAC3NzaC1lZDI1NTE5AAAAIHAgjb8hhCbQ4/2TIVTp6pRlUi97oIezKoHrwtI5hIDU   other comment `), KEY);
    assert.equal(bareKey(KEY), KEY);
    assert.equal(bareKey(""), "");
});

test("a pasted key matches a personal key under another comment", () => {
    const pasted = checkPublicKey(`${KEY} laptop`);
    assert.equal(pasted.kind, "valid");
    if (pasted.kind === "valid") assert.equal(bareKey(pasted.normalized), bareKey(`${KEY} mac-key`));
});
