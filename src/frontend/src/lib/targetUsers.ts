/**
 * 「管理目標主機使用者」清單的純函式：搜尋（帳號 / 新增的人）、分類（全部 / 有分給別人 / 沒分給別人 / 預設）、
 * 排序（預設帳號在最前，其餘照名稱）。搜尋與分類先對全部做，再分頁。
 * Pure helpers for the target-account list: search (account / who added it), buckets (all / shared with someone /
 * not shared / the default), and order (the default first, then by name). Search and buckets run over everything,
 * then the result is paged.
 */

export interface TargetAccount {
    id: number;
    username: string;
    created_by?: string | null;
    created_by_id?: number | null;
    /** 幾位 sharee 的允許清單上有它（只有管理的人拿得到）。/ Sharees holding it (managers only). */
    shared_with?: number | null;
}

export type AccountFilter = "all" | "shared" | "unshared" | "default";

export function sortAccounts<T extends TargetAccount>(list: T[], defaultId: number | null | undefined): T[] {
    return [...list].sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId) || a.username.localeCompare(b.username));
}

export function matchesAccount(a: TargetAccount, filter: AccountFilter, query: string, defaultId: number | null | undefined): boolean {
    if (filter === "shared" && !(a.shared_with && a.shared_with > 0)) return false;
    if (filter === "unshared" && a.shared_with !== 0) return false;
    if (filter === "default" && a.id !== defaultId) return false;
    const q = query.trim().toLowerCase();
    return !q || a.username.toLowerCase().includes(q) || (a.created_by ?? "").toLowerCase().includes(q);
}

export function accountCounts(list: TargetAccount[], defaultId: number | null | undefined): Record<AccountFilter, number> {
    return {
        all: list.length,
        shared: list.filter((a) => matchesAccount(a, "shared", "", defaultId)).length,
        unshared: list.filter((a) => matchesAccount(a, "unshared", "", defaultId)).length,
        default: list.filter((a) => a.id === defaultId).length,
    };
}
