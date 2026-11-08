/**
 * 分享對話框「人員」清單（分享給群組後可能有上百人）：搜尋 + 「全部 / 直接分享 / 經由群組」分類（附數量），之後才分頁。
 * 純函式；數量依搜尋算。
 * The share dialog's people list (a group share can bring in hundreds): search plus "all / shared directly / through a
 * group" buckets with counts, paged afterwards. Pure; the counts follow the search.
 */

export type SharedBucket = "all" | "direct" | "group";

export interface SharedUserLike {
    username: string;
    permission_type?: string;
    allowed_target_usernames?: { username?: string }[];
    via_group?: { name: string } | null;
}

/** 這麼多人以上才有搜尋與分類。/ Search and buckets from this many people on. */
export const SHARED_CONTROLS_FROM = 7;

export function sharedUsersView<T extends SharedUserLike>(rows: T[], query: string, bucket: SharedBucket): { shown: T[]; counts: Record<SharedBucket, number> } {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const fields = (r: T) => [r.username, r.permission_type, r.via_group?.name, ...(r.allowed_target_usernames ?? []).map((a) => a.username)];
    const match = rows.filter((r) => terms.every((term) => fields(r).some((f) => f != null && f.toLowerCase().includes(term))));
    const viaGroup = (r: T) => !!r.via_group;
    const counts = { all: match.length, direct: match.filter((r) => !viaGroup(r)).length, group: match.filter(viaGroup).length };
    const shown = bucket === "direct" ? match.filter((r) => !viaGroup(r)) : bucket === "group" ? match.filter(viaGroup) : match;
    return { shown, counts };
}
