import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIPBOARD_VALUES, clipboardAllowed, clipboardWithin, isClipboardPolicy } from "./desktop.ts";

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
