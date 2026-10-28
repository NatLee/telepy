import { test } from "node:test";
import assert from "node:assert/strict";
import { START, TIMING, caretMode, graphemes, holdFor, isWide, reconcile, sameStart, shownText, step, typeDelay, type TypeState } from "./typewriter.ts";

/** 跑到停下來（或到上限），記下畫面上每一步的字。/ Run until it stops (or a cap), recording the text each step. */
function run(lines: string[], loop: boolean, max = 400) {
    const split = lines.map(graphemes);
    let s: TypeState = START;
    const seen: string[] = [];
    const states: TypeState[] = [];
    for (let i = 0; i < max; i++) {
        const r = step(s, split, loop);
        if (!r) break;
        assert.ok(r.delay >= 0);
        s = r.next;
        states.push(s);
        seen.push(shownText(split[s.line] ?? [], s.shown));
    }
    return { seen, states, last: s };
}

test("graphemes keep CJK characters and emoji whole", () => {
    assert.deepEqual(graphemes("歡迎回來。"), ["歡", "迎", "回", "來", "。"]);
    assert.deepEqual(graphemes("hi 👋🏽"), ["h", "i", " ", "👋🏽"], "an emoji with a skin tone is one grapheme");
    assert.ok(isWide("歡") && isWide("。") && isWide("👋") && !isWide("a") && !isWide(" "));
});

test("one line is typed character by character and kept", () => {
    const { seen, last } = run(["Hi there"], false);
    assert.deepEqual(seen, ["H", "Hi", "Hi ", "Hi t", "Hi th", "Hi the", "Hi ther", "Hi there"]);
    assert.deepEqual(last, { line: 0, shown: 8, phase: "kept" });
    assert.equal(step(last, [graphemes("Hi there")], false), null, "nothing more to do");
});

test("several lines are typed, held, erased and rotated", () => {
    const { seen, states } = run(["ab", "cd"], true, 12);
    assert.deepEqual(seen, ["a", "ab", "a", "", "c", "cd", "c", "", "a", "ab", "a", ""]);
    assert.deepEqual(states[1].phase, "holding");
    assert.deepEqual(states[3], { line: 1, shown: 0, phase: "waiting" }, "erased → the next line, empty");
    assert.deepEqual(states[7], { line: 0, shown: 0, phase: "waiting" }, "the last line wraps to the first");
});

test("the timing feels typed: wide characters slower, a pause after punctuation, longer lines held longer", () => {
    const zh = graphemes("你好，世界");
    const en = graphemes("ab, cd");
    assert.ok(typeDelay(zh, 1) > typeDelay(en, 1), "a CJK character takes longer than a letter");
    assert.ok(typeDelay(en, 3) >= TIMING.punct, "a pause after the comma");
    assert.ok(typeDelay(zh, 3) >= TIMING.punct, "and after the full-width comma");
    assert.equal(typeDelay(en, 1), typeDelay(en, 1), "deterministic");
    assert.ok(holdFor(graphemes("x".repeat(60))) > holdFor(graphemes("x")));
    assert.equal(holdFor(graphemes("x".repeat(500))), TIMING.holdMax);
    // 第一句：等一下才開始打，之後才是每個字的延遲。/ The first character waits for the gap.
    assert.equal(step(START, [graphemes("ab")], false)?.delay, TIMING.gap);
});

test("the caret is solid while moving, blinks when idle and rests once a single line is kept", () => {
    assert.equal(caretMode("typing", false), "solid");
    assert.equal(caretMode("erasing", false), "solid");
    assert.equal(caretMode("holding", false), "blink");
    assert.equal(caretMode("waiting", false), "blink");
    assert.equal(caretMode("kept", false), "rest");
    assert.equal(caretMode("kept", true), "blink", "a line pinned by the preview keeps blinking");
});

test("a trailing space stays visible so the caret does not jump", () => {
    assert.equal(shownText(graphemes("Good to see"), 5), "Good ");
    assert.equal(shownText(graphemes("Good to see"), 6), "Good t", "inner spaces stay ordinary (they can wrap)");
    assert.equal(shownText([], 3), "");
});

test("editing the pinned line keeps what still matches and types the rest", () => {
    const before = [graphemes("Hello"), graphemes("Bye")];
    const typed: TypeState = { line: 0, shown: 5, phase: "kept" };
    // 在後面多打幾個字：接著打。/ Appending: typed on.
    assert.deepEqual(reconcile(typed, before, [graphemes("Hello world"), before[1]], 0), { line: 0, shown: 5, phase: "typing" });
    // 改了中間：從改的地方重打。/ An edit in the middle: retyped from there.
    assert.deepEqual(reconcile(typed, before, [graphemes("Help"), before[1]], 0), { line: 0, shown: 3, phase: "typing" });
    // 刪掉結尾：馬上變短、留著。/ Deleting the end: shorter at once, kept.
    assert.deepEqual(reconcile(typed, before, [graphemes("Hell"), before[1]], 0), { line: 0, shown: 4, phase: "kept" });
    // 釘到另一句：從頭打那句。/ Pinning another line: that line is typed from the start.
    assert.deepEqual(reconcile(typed, before, before, 1), { line: 1, shown: 0, phase: "typing" });
    // 正在刪的句子被釘住：再打回來。/ A line being erased gets pinned: typed back.
    assert.deepEqual(reconcile({ line: 0, shown: 2, phase: "erasing" }, before, before, 0), { line: 0, shown: 2, phase: "typing" });
});

test("without a pin, changes carry on from the shared start", () => {
    const before = [graphemes("Welcome back."), graphemes("Good to see you again.")];
    const holding: TypeState = { line: 0, shown: 13, phase: "holding" };
    assert.equal(reconcile(holding, before, before, null), holding, "nothing changed");
    // 換語言：整句不一樣 → 空一下再打新的。/ Another language: a short empty pause, then the new line.
    const zh = [graphemes("歡迎回來。"), graphemes("很高興再見到你。")];
    assert.deepEqual(reconcile(holding, before, zh, null), { line: 0, shown: 0, phase: "waiting" });
    // 句子被拿掉，原本那句不在了：從第一句開始。/ The current line is gone: back to the first.
    assert.deepEqual(reconcile({ line: 1, shown: 4, phase: "typing" }, before, [before[0]], null), START);
    // 放開釘住的句子：狀態不變，下一步就繼續輪播。/ Releasing a pin: same state, the next step rotates on.
    const kept: TypeState = { line: 1, shown: 22, phase: "kept" };
    assert.equal(reconcile(kept, before, before, null), kept);
    assert.equal(step(kept, before, true)?.next.phase, "holding");
    assert.deepEqual(reconcile(START, before, [], null), START);
});

test("sameStart counts the shared leading graphemes", () => {
    assert.equal(sameStart(graphemes("abc"), graphemes("abd")), 2);
    assert.equal(sameStart([], graphemes("x")), 0);
    assert.equal(sameStart(graphemes("你好"), graphemes("你好嗎")), 2);
});
