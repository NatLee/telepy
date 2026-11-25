/**
 * 手機上的頁面縮放（兩指放大）。遠端畫面（VNC）會把畫面上的每個觸控都拿去操作遠端，所以頁面一旦被放大到畫面塞滿螢幕，
 * 就再也縮不回來。這裡判斷「算不算放大了」、算出一條不管放大多少都維持原本大小的提示列放哪，以及把縮放還原。
 * Page zoom on phones (pinch). The remote screen (VNC) takes every touch on it for the remote side, so once the page is
 * zoomed until that screen fills the display there is no way back. This decides whether the page counts as zoomed, where
 * a bar that keeps its normal size at any zoom goes, and how to reset the zoom.
 */

/** 比 1 大一點點才算（瀏覽器的捨入誤差不算）。/ A little over 1 counts (not the browser's rounding). */
export const ZOOMED_FROM = 1.02;

export function isZoomed(scale: number | null | undefined): boolean {
    return typeof scale === "number" && scale >= ZOOMED_FROM;
}

export interface VisualViewportBox {
    scale: number;
    offsetLeft: number;
    offsetTop: number;
    width: number;
}

/**
 * 貼在看得到的範圍頂端、看起來是原本大小的一條：fixed 的座標是 layout viewport 的，所以放在 visual viewport 的左上角，
 * 寬度放大 scale 倍再整條縮小 1/scale。
 * A bar on top of the visible area that looks its normal size: fixed coordinates are the layout viewport's, so it goes to
 * the visual viewport's top-left corner, `scale` times as wide, then shrunk by 1/scale as a whole.
 */
export function zoomBarStyle(v: VisualViewportBox): { left: number; top: number; width: number; transform: string; transformOrigin: string } {
    const s = v.scale > 0 ? v.scale : 1;
    return { left: v.offsetLeft, top: v.offsetTop, width: v.width * s, transform: `scale(${1 / s})`, transformOrigin: "0 0" };
}

/**
 * 還原時暫用的 viewport：保留其他設定，initial-scale 與 maximum-scale 都定成 1。
 * The viewport used for a moment while resetting: the rest kept, initial-scale and maximum-scale both 1.
 */
export function cappedViewport(content: string): string {
    const kept = content.split(",").map((p) => p.trim()).filter((p) => p && !/^(maximum|initial)-scale\s*=/.test(p));
    return [...kept, "initial-scale=1", "maximum-scale=1"].join(", ");
}

/**
 * 試著把頁面縮放還原，回傳有沒有真的回到 1 倍。網頁沒有標準方法改使用者的縮放：這裡把 viewport 暫時定在 1 倍
 * （Chrome 會照做；Safari 要把標籤重新插入才會重讀，而且常常不理），等到頁面回到 1 倍或最多 1.5 秒，再放回原本的設定，
 * 之後一樣能縮放。回傳 false 時，畫面要請使用者自己用兩指縮小。
 * Try to reset the page zoom and report whether it really got back to 1×. There is no standard way for a page to change
 * the user's zoom: the viewport is pinned to 1× for a moment (Chrome follows it; Safari re-reads it only when the tag is
 * re-inserted and often ignores it anyway), until the page is back at 1× or 1.5 s pass, then the original content comes
 * back so zooming keeps working. On false, the page should ask the person to pinch out themselves.
 */
export async function resetPageZoom(doc: Document = document, win: Window = window): Promise<boolean> {
    const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const zoomedNow = () => isZoomed(win.visualViewport?.scale);
    if (!meta) return !zoomedNow();
    const original = meta.content;
    meta.content = cappedViewport(original);
    const parent = meta.parentNode;
    if (parent) parent.insertBefore(meta, meta.nextSibling);
    const start = Date.now();
    while (zoomedNow() && Date.now() - start < 1500) await new Promise((r) => setTimeout(r, 100));
    meta.content = original;
    return !zoomedNow();
}
