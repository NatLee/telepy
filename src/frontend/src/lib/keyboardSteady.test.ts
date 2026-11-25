import { test } from "node:test";
import assert from "node:assert/strict";
import { isKeyboardOpen, keyboardShift, nextBaseline } from "./keyboardSteady.ts";

test("the keyboard is up when the visible height drops well below the tallest seen at this width", () => {
    let b = nextBaseline(null, 390, 780);
    b = nextBaseline(b, 390, 844); // 位址列收起 / the address bar hides
    assert.equal(b.height, 844);
    assert.equal(isKeyboardOpen(b, 800), false); // 位址列伸縮 / address bar
    assert.equal(isKeyboardOpen(b, 500), true);
    // 轉向就重來。/ Rotation starts over.
    assert.deepEqual(nextBaseline(b, 844, 390), { width: 844, height: 390 });
    assert.equal(isKeyboardOpen(null, 100), false);
});

test("the picture moves up just enough to keep the tapped spot above the keyboard", () => {
    // 點在上半部：不用推。/ A tap near the top needs no push.
    assert.equal(keyboardShift({ tapY: 100, frozenHeight: 700, visibleHeight: 400 }), 0);
    // 點在下面：推到它在可見底部上方 56px。/ A low tap: pushed until it is 56 px above the visible bottom.
    assert.equal(keyboardShift({ tapY: 600, frozenHeight: 700, visibleHeight: 400 }), 256);
    // 不推過頭。/ Never past the end.
    assert.equal(keyboardShift({ tapY: 690, frozenHeight: 700, visibleHeight: 400, margin: 0 }), 290);
    assert.equal(keyboardShift({ tapY: 700, frozenHeight: 700, visibleHeight: 400, margin: 0 }), 300);
    // 不知道點哪：推到底（輸入框多在下方）。/ No known tap: all the way (fields tend to be low).
    assert.equal(keyboardShift({ tapY: null, frozenHeight: 700, visibleHeight: 400 }), 300);
});
