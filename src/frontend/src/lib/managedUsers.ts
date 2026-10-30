/**
 * 管理區「使用者」頁的搜尋與篩選（純函式）。帳號一多，以前那張表只能整頁捲；現在先搜尋 / 篩選全部，再分頁。
 * Search and filters of the admin Users page (pure). The table used to be one long scroll; now search and filters
 * run over everyone first, then the result is paged.
 */

export interface UserRow {
    username: string;
    email: string;
    is_active: boolean;
    is_superuser: boolean;
    mfa_enabled?: boolean;
}

export type UserBucket = "all" | "admins" | "disabled" | "no2fa";
export const USER_BUCKETS: readonly UserBucket[] = ["all", "admins", "disabled", "no2fa"];

/** 每個字都要出現在帳號或 email 裡（不分大小寫）。/ Every word must appear in the username or email (case-insensitive). */
export function userMatches(user: UserRow, query: string): boolean {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const hay = `${user.username} ${user.email}`.toLowerCase();
    return words.every((w) => hay.includes(w));
}

export function inBucket(user: UserRow, bucket: UserBucket): boolean {
    switch (bucket) {
        case "admins":
            return user.is_superuser;
        case "disabled":
            return !user.is_active;
        case "no2fa":
            // 停用的帳號登不進來，不算。/ Disabled accounts can't sign in, so they don't count.
            return user.is_active && !user.mfa_enabled;
        default:
            return true;
    }
}

/** 搜尋之後各篩選的筆數。/ How many match each filter after the search. */
export function bucketCounts(users: readonly UserRow[], query: string): Record<UserBucket, number> {
    const found = users.filter((u) => userMatches(u, query));
    return Object.fromEntries(USER_BUCKETS.map((b) => [b, found.filter((u) => inBucket(u, b)).length])) as Record<UserBucket, number>;
}

export function filterUsers<T extends UserRow>(users: readonly T[], query: string, bucket: UserBucket): T[] {
    return users.filter((u) => userMatches(u, query) && inBucket(u, bucket));
}
