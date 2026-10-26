/**
 * 「已分享給 N 人」浮層的名單：最多列 8 人，多的收成一行「… 還有 N 人」。純函式，`sharedWith.test.ts` 有測試。
 * The "Shared with N" panel's list: at most 8 names, the rest folded into one "… and N more" line.
 */

/** 浮層最多列幾人。/ How many names the panel lists at most. */
export const SHAREE_PREVIEW_MAX = 8;

/**
 * 前 `max` 位與還沒列出的人數。`total`（列表的 `shared_with_count`）比名單長時以它為準，免得少算。
 * The first `max` people and how many are left out; `total` (the list's `shared_with_count`) wins when it is larger.
 */
export function shareePreview<T>(list: readonly T[], total: number = list.length, max: number = SHAREE_PREVIEW_MAX): { shown: T[]; more: number } {
    const shown = list.slice(0, Math.max(0, max));
    return { shown, more: Math.max(total, list.length) - shown.length };
}
