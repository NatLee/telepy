import { test } from "node:test";
import assert from "node:assert/strict";
import { tilesFitAcross } from "./openTiles.ts";

test("four tiles go across only when the longest label fits on one line", () => {
    // 304px 的卡片（19rem）、間距 8、內距 + 邊框 10：每顆內部 60px。/ A 19rem card: 60px inside each tile.
    const row = { rowWidth: 304, gap: 8, chrome: 10 };
    assert.equal(tilesFitAcross({ ...row, labelWidths: [44, 30, 45, 45] }), true, "zh-TW: 終端機 / 檔案 / 瀏覽器 / 桌面");
    assert.equal(tilesFitAcross({ ...row, labelWidths: [60, 48, 48, 72] }), false, "ja: デスクトップ needs 72px");
    // 卡片寬一點，日文也放得下。/ A wider card fits the Japanese labels too.
    assert.equal(tilesFitAcross({ rowWidth: 360, gap: 8, chrome: 10, labelWidths: [60, 48, 48, 72] }), true);
});

test("edge cases", () => {
    assert.equal(tilesFitAcross({ rowWidth: 300, gap: 8, chrome: 10, labelWidths: [] }), true);
    assert.equal(tilesFitAcross({ rowWidth: 0, gap: 8, chrome: 10, labelWidths: [50] }), true, "not laid out yet: keep the default");
    // 剛好等於可用寬度時算放不下（留 1px）。/ Exactly the available width counts as not fitting (1px slack).
    assert.equal(tilesFitAcross({ rowWidth: 100, gap: 0, chrome: 0, labelWidths: [25, 25, 25, 25] }), false);
    assert.equal(tilesFitAcross({ rowWidth: 100, gap: 0, chrome: 0, labelWidths: [24, 24, 24, 24] }), true);
});
