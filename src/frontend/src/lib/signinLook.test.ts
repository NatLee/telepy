import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LOOK, joinLines, lineLength, mergeUp, messageLines, messageProblem, moveRow, parseSignInLook, pasteRows, pinnedLine, removeRow, styleOf, sunflower, tidyMessage } from "./signinLook.ts";

test("the public endpoint and the cache both parse", () => {
    assert.deepEqual(parseSignInLook({ style: "discreet", oauth_style: "standard", message: "Hi" }), { style: "discreet", oauthStyle: "standard", message: "Hi" });
    assert.deepEqual(parseSignInLook({ style: "standard", oauthStyle: "discreet", message: "" }), { style: "standard", oauthStyle: "discreet", message: "" });
    // 不認得的樣子、缺欄位、不是物件 → null（頁面改用預設或重抓）。/ Unknown looks or shapes → null.
    assert.equal(parseSignInLook({ style: "neon", oauth_style: "standard" }), null);
    assert.equal(parseSignInLook({ style: "discreet" }), null);
    assert.equal(parseSignInLook(null), null);
    assert.equal(parseSignInLook("discreet"), null);
    assert.equal(parseSignInLook({ style: "discreet", oauth_style: "discreet", message: 3 })?.message, "");
});

test("each page reads its own look", () => {
    const look = { ...DEFAULT_LOOK, oauthStyle: "discreet" as const };
    assert.equal(styleOf(look, "signin"), "standard");
    assert.equal(styleOf(look, "oauth"), "discreet");
});

test("the lines are tidied and limited like the backend", () => {
    assert.equal(tidyMessage("  Hello \r\n\n   \n  world  \n"), "Hello\nworld", "trimmed, blank lines dropped");
    assert.deepEqual(messageLines("One\n\n  Two \r\n"), ["One", "Two"]);
    assert.deepEqual(messageLines("   "), [], "blank = the built-in lines");
    assert.equal(joinLines(["  a ", "", "b", "   "]), "a\nb", "editor rows → the stored text");
    assert.equal(messageProblem("   "), null);
    assert.equal(lineLength(" 字字 "), 2, "counted in characters, trimmed");
    assert.equal(messageProblem("字".repeat(80)), null);
    assert.equal(messageProblem("x".repeat(81)), "tooLong");
    assert.equal(messageProblem(Array(6).fill("a").join("\n")), null);
    assert.equal(messageProblem(Array(7).fill("a").join("\n")), "tooManyLines");
    assert.equal(messageProblem(Array(6).fill("a").join("\n\n") + "\n\n  "), null, "blank lines don't count");
});

test("rows edit like a text editor", () => {
    // Enter 在游標處切開這列。/ Enter splits the row at the caret.
    assert.deepEqual(pasteRows(["Hello world"], 0, 5, 5, "\n"), { rows: ["Hello", " world"], focus: 1, caret: 0, dropped: 0 });
    // 貼上好幾行：各成一列，游標後面的字接在最後一段後面。/ Pasting several lines: one row each, the tail follows the last.
    assert.deepEqual(pasteRows(["ab", "z"], 0, 1, 1, "1\r\n2\n3"), { rows: ["a1", "2", "3b", "z"], focus: 2, caret: 1, dropped: 0 });
    // 取代選取的字。/ Replaces the selection.
    assert.deepEqual(pasteRows(["abcd"], 0, 1, 3, "X"), { rows: ["aXd"], focus: 0, caret: 2, dropped: 0 });
    // 最多六列，放不下的不加。/ At most six rows; the rest is left out.
    const five = ["a", "b", "c", "d", "e"];
    assert.deepEqual(pasteRows(five, 4, 1, 1, "\nf\ng\nh"), { rows: ["a", "b", "c", "d", "e", "f"], focus: 5, caret: 1, dropped: 2 });
    assert.deepEqual(pasteRows(["a", "b", "c", "d", "e", "f"], 2, 1, 1, "\n").rows, ["a", "b", "c", "d", "e", "f"], "Enter on a full list does nothing");
    // Backspace 在開頭接到上一列。/ Backspace at the start joins the row above.
    assert.deepEqual(mergeUp(["ab", "cd", "e"], 1), { rows: ["abcd", "e"], focus: 0, caret: 2, dropped: 0 });
    assert.equal(mergeUp(["ab"], 0), null);
    assert.deepEqual(removeRow(["a", "b"], 0), ["b"]);
    assert.deepEqual(removeRow(["a"], 0), [""], "one empty row stays");
    assert.deepEqual(moveRow(["a", "b", "c"], 2, -1), ["a", "c", "b"]);
    assert.deepEqual(moveRow(["a", "b"], 0, -1), ["a", "b"], "the first row cannot go up");
});

test("the preview pins the edited line, counting only non-blank rows", () => {
    assert.equal(pinnedLine(["a", "", "b"], 2), 1, "the blank row in between is dropped on save");
    assert.equal(pinnedLine(["a", "", "b"], 1), null, "a blank row pins nothing");
    assert.equal(pinnedLine(["a"], null), null);
});

test("the sunflower starts at the centre, stays inside the radius and is deterministic", () => {
    const dots = sunflower(400, 360);
    assert.equal(dots.length, 400);
    assert.deepEqual(dots[0], { x: 0, y: 0, t: 0 });
    assert.equal(dots[399].t, 1);
    for (const d of dots) {
        assert.ok(Math.hypot(d.x, d.y) <= 360.2, `${d.x},${d.y} is outside`);
        assert.ok(d.t >= 0 && d.t <= 1);
    }
    assert.deepEqual(sunflower(400, 360), dots, "server and browser render the same field");
    // 越往外越遠（t 單調遞增），漣漪的延遲才會由內往外。/ t grows outward, so the ripple delay does too.
    assert.ok(dots.every((d, i) => i === 0 || d.t >= dots[i - 1].t));
    assert.deepEqual(sunflower(0, 100), []);
    assert.deepEqual(sunflower(1, 100), [{ x: 0, y: 0, t: 0 }]);
});
