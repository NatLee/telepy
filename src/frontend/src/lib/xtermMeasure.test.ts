import { test } from "node:test";
import assert from "node:assert/strict";
import { RETRY_AFTER_MS, cellMismatch, ensureMeasured, markIfHidden, remeasure, type CellWidths } from "./xtermMeasure.ts";

/** 假的 xterm:記下 fontFamily 的每次設定,可切換顯示 / 隱藏。/ A fake xterm that logs fontFamily writes and can be hidden. */
function fakeTerm(family: string, visible: boolean, fontSize = 13) {
    const writes: string[] = [];
    const state = { visible, family };
    const term = {
        element: { getClientRects: () => ({ length: state.visible ? 1 : 0 }) },
        options: {
            fontSize,
            get fontFamily() { return state.family; },
            set fontFamily(v: string) { state.family = v; writes.push(v); },
        },
    };
    return { term, writes, state };
}

/** 固定回傳的量測(格子寬一致)。/ A measurement that always agrees. */
const agree = (): CellWidths => ({ applied: 7.83, actual: 7.83 });

test("cellMismatch needs both widths and a gap above the tolerance", () => {
    assert.equal(cellMismatch({ applied: 10.1875, actual: 7.8125 }), true); // the reported case: 17px cells, 13px font
    assert.equal(cellMismatch({ applied: 8.4375, actual: 8.4062 }), false); // Menlo vs JetBrains while a font loads
    assert.equal(cellMismatch({ applied: null, actual: 7.8 }), false);
    assert.equal(cellMismatch({ applied: 7.8, actual: null }), false);
    assert.equal(cellMismatch({ applied: 0, actual: 7.8 }), false);
});

test("remeasure goes through monospace and back to the same family", () => {
    const { term, writes } = fakeTerm('"Hack Nerd Font Mono", monospace', true);
    remeasure(term);
    assert.deepEqual(writes, ["monospace", '"Hack Nerd Font Mono", monospace']);
    assert.equal(term.options.fontFamily, '"Hack Nerd Font Mono", monospace');
});

test("a visible terminal whose widths agree is left alone", () => {
    const { term, writes } = fakeTerm("Hack", true);
    markIfHidden(term);
    assert.equal(ensureMeasured(term, agree), false);
    assert.deepEqual(writes, []);
});

test("a change while hidden is re-measured once, and only after the terminal shows", () => {
    const { term, writes, state } = fakeTerm("Hack", false);
    markIfHidden(term);
    // 還隱藏著:量了也是 0,先不動。/ Still hidden: measuring would read 0, so wait.
    assert.equal(ensureMeasured(term, agree), false);
    assert.deepEqual(writes, []);
    state.visible = true;
    assert.equal(ensureMeasured(term, agree), true);
    assert.deepEqual(writes, ["monospace", "Hack"]);
    // 量過就清掉。/ Cleared once measured.
    assert.equal(ensureMeasured(term, agree), false);
    assert.equal(writes.length, 2);
});

test("a visible terminal with a stale cell width is re-measured, whatever made it stale", () => {
    const { term, writes } = fakeTerm("Hack", true);
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (m: string) => { warnings.push(m); };
    try {
        let calls = 0;
        // 第一次量:格子停在 17px;重新量之後對上了。/ First reading: cells stuck at 17px; agrees after the re-measure.
        const measure = (): CellWidths => (calls++ === 0 ? { applied: 10.1875, actual: 7.8125 } : { applied: 7.8125, actual: 7.8125 });
        assert.equal(ensureMeasured(term, measure), true);
        assert.deepEqual(writes, ["monospace", "Hack"]);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /10\.188px.*7\.813px; re-measured → 7\.813px$/);
    } finally {
        console.warn = warn;
    }
});

test("when re-measuring does not help, it backs off, warns once and tries again later", () => {
    const { term, writes } = fakeTerm("Hack", true);
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (m: string) => { warnings.push(m); };
    try {
        const stuck = (): CellWidths => ({ applied: 10.1875, actual: 7.8125 });
        assert.equal(ensureMeasured(term, stuck, 1000), true);
        assert.match(warnings[0], /did not help/);
        // 冷卻中:不再量、不再動。/ Backing off: no measuring, no writes.
        assert.equal(ensureMeasured(term, stuck, 1000 + RETRY_AFTER_MS - 1), false);
        assert.equal(writes.length, 2);
        // 時間到再試,但不重複警告。/ Retried after the wait, without a second warning.
        assert.equal(ensureMeasured(term, stuck, 1000 + RETRY_AFTER_MS), true);
        assert.equal(writes.length, 4);
        assert.equal(warnings.length, 1);
        // 換了字級就馬上再試。/ A new size is tried at once.
        term.options.fontSize = 14;
        assert.equal(ensureMeasured(term, stuck, 1000 + RETRY_AFTER_MS + 1), true);
        assert.equal(writes.length, 6);
        // 原因消失後(量到一致)就好了,不再試。/ Once the cause is gone it settles and stops.
        let calls = 0;
        const heals = (): CellWidths => (calls++ === 0 ? { applied: 10.1875, actual: 7.8125 } : { applied: 7.8125, actual: 7.8125 });
        assert.equal(ensureMeasured(term, heals, 1000 + 3 * RETRY_AFTER_MS), true);
        assert.equal(ensureMeasured(term, agree, 1000 + 3 * RETRY_AFTER_MS + 1), false);
    } finally {
        console.warn = warn;
    }
});

test("a hidden-tab change that is fixed by re-measuring does not warn", () => {
    const { term, state } = fakeTerm("Hack", false);
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (m: string) => { warnings.push(m); };
    try {
        markIfHidden(term);
        state.visible = true;
        let calls = 0;
        const heals = (): CellWidths => (calls++ === 0 ? { applied: 10.1875, actual: 7.8125 } : { applied: 7.8125, actual: 7.8125 });
        assert.equal(ensureMeasured(term, heals), true);
        assert.deepEqual(warnings, []);
    } finally {
        console.warn = warn;
    }
});

test("a terminal without an element counts as hidden", () => {
    const writes: string[] = [];
    const term = { element: null, options: { set fontFamily(v: string) { writes.push(v); }, get fontFamily() { return "Hack"; } } };
    markIfHidden(term);
    assert.equal(ensureMeasured(term, agree), false);
    assert.deepEqual(writes, []);
});
