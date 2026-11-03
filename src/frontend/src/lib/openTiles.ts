/**
 * 「開啟」方塊要不要一排四顆：最長的標籤在一顆方塊裡放不放得下一行。用量的，不用固定寬度——日文的「デスクトップ」
 * 在 19rem 的卡片裡會被拆成一字一行，換語言、字型或顯示大小，門檻都不一樣。不碰 React。
 * Whether the "open" tiles fit in one row: the longest label must fit on one line inside one tile. Measured, not a
 * fixed width — Japanese 「デスクトップ」 broke per character at the old 19rem threshold, and the right width changes
 * with language, font and display size. No React.
 */

export interface TileRow {
    /** 每個標籤一行時的寬度（px）。/ Each label's one-line width in px. */
    labelWidths: number[];
    /** 整排的寬度（px）。/ The row's width in px. */
    rowWidth: number;
    /** 方塊之間的間距（px）。/ The gap between tiles in px. */
    gap: number;
    /** 一顆方塊左右的內距加邊框（px）。/ A tile's horizontal padding plus border in px. */
    chrome: number;
}

/** 一排放得下全部（每個標籤都一行）。/ Every label fits on one line with all tiles in one row. */
export function tilesFitAcross({ labelWidths, rowWidth, gap, chrome }: TileRow): boolean {
    const n = labelWidths.length;
    if (n === 0 || rowWidth <= 0) return true;
    const inner = (rowWidth - gap * (n - 1)) / n - chrome;
    // 留 1px 給次像素的捨入。/ 1px of slack for sub-pixel rounding.
    return Math.max(...labelWidths) <= inner - 1;
}
