/**
 * 隱藏中的終端機換字型 / 字級後,重新顯示時要重新量字寬。
 * xterm 5.3 的 DOM renderer 用兩份量測排字:格子寬來自 CharSizeService(量測元素在 .xterm 裡,終端機 display:none 時
 * 量到 0 就沿用舊值),每個字的寬度來自 WidthCache(掛在 <body> 下,隱藏時照樣量得到)。兩者的差被當成 letter-spacing
 * 加在每個字上,所以隱藏期間換了字型 / 字級,顯示時字是新的大小、格子還是舊的 → 字距被撐開(終端機頁的背景分頁、
 * 網路頁縮小或非作用中的終端機)。改字型的地方用 markIfHidden 記下隱藏中的終端機,顯示後 fit 之前呼叫 ensureMeasured。
 * Re-measuring a terminal whose font or size changed while it was hidden.
 * xterm 5.3's DOM renderer lays text out from two measurements: the cell width from CharSizeService (its measuring
 * element sits inside .xterm; while the terminal is display:none it reads 0 and keeps the old value) and each
 * character's width from WidthCache (attached to <body>, so it measures while hidden too). The difference becomes
 * letter-spacing on every character, so after a font / size change on a hidden terminal the glyphs come back at the
 * new size in old-size cells, spaced apart (background shell tabs, minimised or inactive dock terminals). Call
 * markIfHidden where the font changes and ensureMeasured once a terminal shows, before fitting it.
 */

/** 用得到的 xterm 部分。/ The part of an xterm used here. */
export interface MeasurableTerminal {
    element?: { getClientRects(): { length: number } } | null;
    options: { fontFamily?: string };
}

const stale = new WeakSet<object>();

function rendered(term: MeasurableTerminal): boolean {
    return !!term.element && term.element.getClientRects().length > 0;
}

/**
 * 強迫 xterm 重新量字寬:它只在值改變時才量,所以先換成 monospace 再換回來。
 * Forces xterm to re-measure: it only measures when the value changes, hence the monospace round trip.
 */
export function remeasure(term: MeasurableTerminal) {
    const family = term.options.fontFamily;
    term.options.fontFamily = "monospace";
    term.options.fontFamily = family;
}

/** 剛換了字型 / 字級:終端機正隱藏著就記下來。/ Just changed the font or size: remember the terminal if it is hidden. */
export function markIfHidden(term: MeasurableTerminal) {
    if (!rendered(term)) stale.add(term);
}

/**
 * 顯示後、fit 之前呼叫:隱藏期間換過字型 / 字級就重新量一次。回傳是否量了。
 * Call once the terminal shows, before fitting: re-measures if its font or size changed while hidden. Returns whether it did.
 */
export function ensureMeasured(term: MeasurableTerminal): boolean {
    if (!stale.has(term) || !rendered(term)) return false;
    stale.delete(term);
    remeasure(term);
    return true;
}
