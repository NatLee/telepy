/**
 * 「這一頁的區塊」清單現在標哪一塊：頁面往下捲，頂端（扣掉黏著的標題列）已經捲過的最後一塊就是現在這塊；捲到底的時候
 * 最後幾塊的頂端永遠到不了那條線，所以剛點的那塊還看得到就留著它，否則標最後一塊。純函式。
 * Which block the "on this page" list marks: the last one whose top has scrolled past the line under the sticky header.
 * At the bottom of the page the last short blocks can never reach that line, so the block just clicked stays marked while
 * it is still visible; otherwise the last one is. Pure.
 */

export interface SectionBox {
    id: string;
    /** 相對視窗的上緣 / 下緣（px）。/ Top / bottom relative to the viewport (px). */
    top: number;
    bottom: number;
}

export function activeSection(boxes: SectionBox[], opts: { line: number; viewport: number; atBottom: boolean; preferred?: string | null }): string | null {
    if (boxes.length === 0) return null;
    const { line, viewport, atBottom, preferred } = opts;
    const pref = preferred ? boxes.find((b) => b.id === preferred) : undefined;
    const visible = (b: SectionBox) => b.bottom > line && b.top < viewport;
    if (atBottom) return pref && visible(pref) ? pref.id : boxes[boxes.length - 1].id;
    let current = boxes[0].id;
    for (const b of boxes) if (b.top <= line + 1) current = b.id;
    // 剛點的那塊上緣停在線上（捲動的取整）：照點的算。/ The clicked block sits on the line (scroll rounding): keep it.
    if (pref && Math.abs(pref.top - line) <= 2) return pref.id;
    return current;
}
