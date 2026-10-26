import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIPBOARD_VALUES, clipboardAllowed, clipboardWithin, isClipboardPolicy, startFailure } from "./desktop.ts";

test("the site limit caps the user's clipboard choice like the backend does", () => {
    assert.equal(clipboardWithin("both", "both"), "both");
    assert.equal(clipboardWithin("both", "to_remote"), "to_remote");
    assert.equal(clipboardWithin("both", "off"), "off");
    assert.equal(clipboardWithin("to_remote", "both"), "to_remote");
    assert.equal(clipboardWithin("to_remote", "off"), "off");
    assert.equal(clipboardWithin("off", "both"), "off");
    // 上限以下的選項都能選，以上的關掉。/ Choices at or under the limit stay enabled.
    assert.deepEqual(CLIPBOARD_VALUES.filter((v) => clipboardAllowed(v, "to_remote")), ["to_remote", "off"]);
    assert.deepEqual(CLIPBOARD_VALUES.filter((v) => clipboardAllowed(v, "off")), ["off"]);
    assert.ok(isClipboardPolicy("to_remote") && !isClipboardPolicy("sideways") && !isClipboardPolicy(null));
});

test("a refused port explains Direct IP Access in RustDesk mode", () => {
    const vars = { account: "natlee", address: "127.0.0.1:21118" };
    assert.equal(startFailure("target_unreachable", 502, vars, "rustdesk").key, "desktop.err.rdDirectIpOff");
    assert.equal(startFailure("target_unreachable", 502, vars, "rdp").key, "desktop.err.targetUnreachable");
    assert.equal(startFailure("target_unreachable", 502, vars).key, "desktop.err.targetUnreachable", "RDP / VNC wording by default");
    assert.deepEqual(startFailure("target_unreachable", 502, vars, "rustdesk").vars, { address: "127.0.0.1:21118" });
    assert.equal(startFailure("device_auth", 502, vars, "rustdesk").key, "desktop.err.deviceAuth", "other codes are the same in every mode");
});
