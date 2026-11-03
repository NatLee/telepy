import { test } from "node:test";
import assert from "node:assert/strict";
import { activeSection, type SectionBox } from "./sectionOutline.ts";

const boxes = (...tops: number[]): SectionBox[] => tops.map((top, i) => ({ id: `s${i}`, top, bottom: (tops[i + 1] ?? top + 300) - 16 }));
const opts = { line: 80, viewport: 900, atBottom: false };

test("the last block whose top passed the line is current", () => {
    assert.equal(activeSection([], opts), null);
    // 還沒捲：第一塊。/ Not scrolled yet: the first block.
    assert.equal(activeSection(boxes(200, 700, 1300), opts), "s0");
    assert.equal(activeSection(boxes(-400, 80, 700), opts), "s1");
    assert.equal(activeSection(boxes(-900, -300, 60), opts), "s2");
});

test("at the bottom the clicked block stays marked while it is visible", () => {
    const end = { ...opts, atBottom: true };
    // 最後兩塊都很短，頂端到不了線。/ The last two blocks are short and never reach the line.
    const b = boxes(-1200, -700, 300, 600);
    assert.equal(activeSection(b, end), "s3");
    assert.equal(activeSection(b, { ...end, preferred: "s2" }), "s2");
    // 點的那塊已經捲出畫面：標最後一塊。/ The clicked block scrolled away: the last one.
    assert.equal(activeSection(b, { ...end, preferred: "s0" }), "s3");
});

test("a clicked block sitting on the line wins over rounding", () => {
    const b = boxes(-700, 81.5, 700);
    assert.equal(activeSection(b, { ...opts, preferred: "s1" }), "s1");
});
