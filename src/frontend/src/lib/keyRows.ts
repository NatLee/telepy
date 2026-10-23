/**
 * 裝置金鑰面板的列篩選（純函式）：authorized_keys 可能有幾百行，要能搜尋、分類（附數量）、分批顯示、批次勾選移除。
 * Pure helpers for the device-key panel's rows: an authorized_keys file can hold hundreds of keys, so rows are
 * searched, bucketed (with counts), shown in pages and selected in bulk for removal.
 */
import type { ViewAccount, ViewRow } from "@/types/keys";

/** 全部 / 在清單上 / 不是 Telepy 放的 / 需要處理。/ All, on the list, not from Telepy, needs attention. */
export type RowBucket = "all" | "list" | "other" | "attention";

/** 整個面板這麼多列以上才顯示搜尋 / 分類。/ Show the filter bar from this many rows in the panel. */
export const ROW_FILTER_FROM = 8;
/** 每個帳號先顯示幾列。/ Rows shown per account before "show more". */
export const ROWS_COLLAPSED = 10;
/** 「再顯示」一次加幾列。/ Rows added per "show more". */
export const ROWS_STEP = 50;

export function inBucket(r: ViewRow, bucket: RowBucket, online: boolean): boolean {
    switch (bucket) {
        case "all":
            return true;
        case "list":
            return r.on_list;
        case "other":
            return r.state === "manual" || r.state === "unknown";
        case "attention":
            return r.state === "error" || r.state === "removing" || r.state === "invalid" || (r.state === "pending" && online);
    }
}

/** 查詢字串拆成小寫詞；每個詞都要出現（AND）。/ Lower-cased words, all of which must match. */
export function queryTerms(query: string): string[] {
    return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** 每個詞都出現在這些欄位裡嗎（不分大小寫）。/ Whether every term appears in the fields (case-insensitive). */
export function fieldsMatch(fields: (string | number | null | undefined)[], terms: string[]): boolean {
    if (terms.length === 0) return true;
    const text = fields
        .filter((f) => f !== null && f !== undefined && f !== "")
        .join("\n")
        .toLowerCase();
    return terms.every((t) => text.includes(t));
}

export function rowMatches(r: ViewRow, terms: string[]): boolean {
    return fieldsMatch([r.name, r.owner, r.comment, r.fingerprint, r.key_type, r.bits, r.options, r.raw, r.error], terms);
}

/** 能從裝置移除的列：不是 Telepy 放的、有指紋（後端也會擋服務金鑰與清單上的）。 */
export function isRemovable(r: ViewRow): boolean {
    return (r.state === "manual" || r.state === "unknown") && !!r.fingerprint;
}

export type BucketCounts = Record<RowBucket, number>;

export interface FilteredAccount {
    account: ViewAccount;
    /** 符合搜尋與分類的列（保持後端順序）。/ Matching rows, in server order. */
    rows: ViewRow[];
}

/**
 * 套用搜尋與分類。數量依搜尋算（分類鈕上的數字 = 搜尋結果裡各類有幾列）。
 * Applies the query and the bucket; bucket counts reflect the query.
 */
export function filterAccounts(accounts: ViewAccount[], query: string, bucket: RowBucket, online: boolean): { accounts: FilteredAccount[]; counts: BucketCounts; total: number } {
    const terms = queryTerms(query);
    const counts: BucketCounts = { all: 0, list: 0, other: 0, attention: 0 };
    let total = 0;
    const out = accounts.map((account) => {
        const rows: ViewRow[] = [];
        for (const r of account.rows) {
            total++;
            if (!rowMatches(r, terms)) continue;
            counts.all++;
            if (inBucket(r, "list", online)) counts.list++;
            if (inBucket(r, "other", online)) counts.other++;
            if (inBucket(r, "attention", online)) counts.attention++;
            if (inBucket(r, bucket, online)) rows.push(r);
        }
        return { account, rows };
    });
    return { accounts: out, counts, total };
}

/** 先顯示幾列：只差一兩列就全部顯示，不要出現「再顯示 1 列」。/ Rows to render; never leave just one or two behind. */
export function visibleCount(total: number, limit: number): number {
    return total <= limit + 2 ? total : limit;
}

/** 「全部顯示」的上限（再多就請先搜尋）。/ "Show all" is offered up to this many rows. */
export const SHOW_ALL_MAX = 1000;

/** 選取的鍵：`帳號\n指紋`。/ Selection key. */
export function selectionKey(username: string, fingerprint: string): string {
    return `${username}\n${fingerprint}`;
}

/** 把選取依帳號分組（批次移除一個帳號一個請求）。/ Groups the selection by account (one request each). */
export function groupSelection(selected: Iterable<string>): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const k of selected) {
        const i = k.indexOf("\n");
        if (i < 0) continue;
        const user = k.slice(0, i);
        const list = out.get(user) ?? [];
        list.push(k.slice(i + 1));
        out.set(user, list);
    }
    return out;
}

/** 選取裡還能移除的（重新整理後消失或變成清單上的就不算）。/ The selection minus rows that are gone or no longer removable. */
export function liveSelection(selected: Set<string>, accounts: ViewAccount[]): Set<string> {
    if (selected.size === 0) return selected;
    const live = new Set<string>();
    for (const a of accounts) {
        for (const r of a.rows) {
            if (isRemovable(r) && selected.has(selectionKey(a.username, r.fingerprint!))) live.add(selectionKey(a.username, r.fingerprint!));
        }
    }
    return live.size === selected.size ? selected : live;
}
