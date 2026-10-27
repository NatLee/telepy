/**
 * 清單分頁的純函式：頁數、目前頁夾在範圍內、這一頁的切片與頁碼列（中間用 … 省略）。搜尋與篩選一律在分頁之前、
 * 對全部資料做。
 * Pure helpers for paged lists: page count, clamping, the page's slice and the page-number row (with gaps). Search
 * and filters always run on everything, before paging.
 */

/** 每頁筆數的選項。/ Page size choices. */
export const PAGE_SIZES: readonly number[] = [10, 25, 50, 100];
/** 卡片格（1–4 欄）用的：每頁都排滿整列。/ For card grids (1–4 columns): every page fills whole rows. */
export const CARD_PAGE_SIZES: readonly number[] = [12, 24, 48, 96];

export function pageCount(total: number, size: number): number {
    return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, size)));
}

export function clampPage(page: number, count: number): number {
    const p = Number.isFinite(page) ? Math.floor(page) : 1;
    return Math.min(Math.max(1, p), Math.max(1, count));
}

/** 這一頁是第幾筆到第幾筆（從 1 起算；沒有資料時是 0–0）。/ First and last item number on the page (1-based; 0–0 when empty). */
export function pageRange(page: number, size: number, total: number): { from: number; to: number } {
    if (total <= 0) return { from: 0, to: 0 };
    const p = clampPage(page, pageCount(total, size));
    return { from: (p - 1) * size + 1, to: Math.min(total, p * size) };
}

export function pageSlice<T>(items: T[], page: number, size: number): T[] {
    const p = clampPage(page, pageCount(items.length, size));
    return items.slice((p - 1) * size, p * size);
}

/**
 * 頁碼列：頁數少就全列；多的話固定 7 格——第一頁、最後一頁、目前頁與左右各一頁，中間用 "gap"（…）。
 * Page numbers: all of them when few; otherwise always seven slots — first, last, current ±1, "gap" for the rest.
 */
export function pageWindow(page: number, count: number): (number | "gap")[] {
    const n = Math.max(1, count);
    const p = clampPage(page, n);
    if (n <= 7) return Array.from({ length: n }, (_, i) => i + 1);
    if (p <= 4) return [1, 2, 3, 4, 5, "gap", n];
    if (p >= n - 3) return [1, "gap", n - 4, n - 3, n - 2, n - 1, n];
    return [1, "gap", p - 1, p, p + 1, "gap", n];
}
