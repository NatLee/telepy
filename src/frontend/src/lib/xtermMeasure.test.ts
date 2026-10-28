import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureMeasured, markIfHidden, remeasure } from "./xtermMeasure.ts";

/** 假的 xterm:記下 fontFamily 的每次設定,可切換顯示 / 隱藏。/ A fake xterm that logs fontFamily writes and can be hidden. */
function fakeTerm(family: string, visible: boolean) {
    const writes: string[] = [];
    const state = { visible, family };
    const term = {
        element: { getClientRects: () => ({ length: state.visible ? 1 : 0 }) },
        options: {
            get fontFamily() { return state.family; },
            set fontFamily(v: string) { state.family = v; writes.push(v); },
        },
    };
    return { term, writes, state };
}

test("remeasure goes through monospace and back to the same family", () => {
    const { term, writes } = fakeTerm('"Hack Nerd Font Mono", monospace', true);
    remeasure(term);
    assert.deepEqual(writes, ["monospace", '"Hack Nerd Font Mono", monospace']);
    assert.equal(term.options.fontFamily, '"Hack Nerd Font Mono", monospace');
});

test("a change on a visible terminal needs no re-measure later", () => {
    const { term, writes } = fakeTerm("Hack", true);
    markIfHidden(term);
    assert.equal(ensureMeasured(term), false);
    assert.deepEqual(writes, []);
});

test("a change while hidden is re-measured once, and only after the terminal shows", () => {
    const { term, writes, state } = fakeTerm("Hack", false);
    markIfHidden(term);
    // 還隱藏著:量了也是 0,先不動。/ Still hidden: measuring would read 0, so wait.
    assert.equal(ensureMeasured(term), false);
    assert.deepEqual(writes, []);
    state.visible = true;
    assert.equal(ensureMeasured(term), true);
    assert.deepEqual(writes, ["monospace", "Hack"]);
    // 量過就清掉。/ Cleared once measured.
    assert.equal(ensureMeasured(term), false);
    assert.equal(writes.length, 2);
});

test("a terminal without an element counts as hidden", () => {
    const writes: string[] = [];
    const term = { element: null, options: { set fontFamily(v: string) { writes.push(v); }, get fontFamily() { return "Hack"; } } };
    markIfHidden(term);
    assert.equal(ensureMeasured(term), false);
    assert.deepEqual(writes, []);
});
