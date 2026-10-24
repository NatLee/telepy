/**
 * 金鑰頁「我的金鑰」在金鑰很多時的篩選與排序（純函式）。
 * Filtering and sorting for the keys page's "My keys" when there are many (pure).
 */
import type { UserKey } from "@/types/keys";
import { fieldsMatch, queryTerms } from "@/lib/keyRows";

/** 全部 / 在裝置上 / 不在任何裝置 / 從沒用過。/ All, on devices, on no device, never used. */
export type KeyListBucket = "all" | "placed" | "unplaced" | "unused";
export type KeyListSort = "recent" | "name" | "newest";

/** 這麼多把以上才有搜尋 / 分類 / 排序。/ Controls from this many keys on. */
export const KEY_LIST_FILTER_FROM = 7;
/** 收合時顯示幾張卡（三欄 × 三列）。/ Cards shown while collapsed (three rows of three). */
export const KEY_LIST_COLLAPSED = 9;
/** 裝置矩陣最多先顯示幾欄金鑰。/ Key columns the device matrix shows before "show all". */
export const MATRIX_COLUMNS = 4;

export function inKeyBucket(k: UserKey, bucket: KeyListBucket, devices: number): boolean {
    switch (bucket) {
        case "all":
            return true;
        case "placed":
            return devices > 0;
        case "unplaced":
            return devices === 0;
        case "unused":
            return !k.last_used_at;
    }
}

function time(s: string | null): number {
    const n = s ? Date.parse(s) : NaN;
    return Number.isNaN(n) ? -Infinity : n;
}

/** 最近用過的在前（沒用過的最後，再依新增時間）；名稱；最新新增。/ Recent use first; name; newest. */
export function sortKeys(keys: UserKey[], sort: KeyListSort, locale?: string): UserKey[] {
    const out = [...keys];
    switch (sort) {
        case "recent":
            return out.sort((a, b) => time(b.last_used_at) - time(a.last_used_at) || time(b.created_at) - time(a.created_at));
        case "name":
            return out.sort((a, b) => a.host_friendly_name.localeCompare(b.host_friendly_name, locale, { numeric: true, sensitivity: "base" }));
        case "newest":
            return out.sort((a, b) => time(b.created_at) - time(a.created_at) || b.id - a.id);
    }
}

export function keyMatches(k: UserKey, terms: string[]): boolean {
    return fieldsMatch([k.host_friendly_name, k.comment, k.fingerprint, k.key_type, k.bits, k.description, k.last_used_ip], terms);
}

/**
 * 套用搜尋、分類、排序。數量依搜尋算。`devicesOf(id)` = 這把金鑰在幾台裝置的清單上。
 * Applies query, bucket and sort; bucket counts reflect the query.
 */
export function filterKeys(keys: UserKey[], query: string, bucket: KeyListBucket, sort: KeyListSort, devicesOf: (id: number) => number, locale?: string) {
    const terms = queryTerms(query);
    const counts: Record<KeyListBucket, number> = { all: 0, placed: 0, unplaced: 0, unused: 0 };
    const matching: UserKey[] = [];
    for (const k of keys) {
        if (!keyMatches(k, terms)) continue;
        const n = devicesOf(k.id);
        counts.all++;
        if (inKeyBucket(k, "placed", n)) counts.placed++;
        if (inKeyBucket(k, "unplaced", n)) counts.unplaced++;
        if (inKeyBucket(k, "unused", n)) counts.unused++;
        if (inKeyBucket(k, bucket, n)) matching.push(k);
    }
    return { keys: sortKeys(matching, sort, locale), counts };
}
