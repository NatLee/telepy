/**
 * API 呼叫紀錄（`GET /api/auth/tokens/calls`）：`mine` = 自己的（管理員也一樣），`all` = 管理區的全站（可依使用者篩選，
 * `?user=` 當起始值）。token（`?token=`）/ 使用者在後端篩選；狀態、方法、搜尋在前端。依日期分組，「載入更早的」一次多 300 筆
 * （後端最多 1000）。
 * The API call log: `mine` = your own (admins too), `all` = the admin section's whole site (user filter, seeded by
 * `?user=`). Token (`?token=`) and user filters run on the backend; status, method and search here. Grouped by day;
 * "load older" adds 300 rows at a time (the backend caps at 1000).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { withTimes, type CallTimes } from "@/lib/aiActivity";
import { countApiCalls, filterApiCalls, type ApiCall, type ApiCallPage, type MethodFilter, type StatusFilter } from "@/lib/apiCalls";
import { labelDays, type LabeledDayGroup } from "@/lib/timeline";
import type { ViewScope } from "@/components/layout/AdminViews";

export type ApiCallEntry = ApiCall & CallTimes;

export const ALL = "all";
const PAGE = 300;
const MAX_LIMIT = 1000;

export function useApiCalls(scope: ViewScope) {
    const { t, locale } = useI18n();
    const all = scope === "all";
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    // 只看一把 token：放在網址上，token 那一列可以連過來。/ One token only: in the URL so a token row can link here.
    const tokenParam = searchParams.get("token");
    const tokenFilter = tokenParam && /^\d+$/.test(tokenParam) ? tokenParam : ALL;
    const setTokenFilter = useCallback(
        (value: string) => {
            const params = new URLSearchParams(searchParams.toString());
            if (value === ALL) params.delete("token");
            else params.set("token", value);
            const qs = params.toString();
            router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
        },
        [router, pathname, searchParams]
    );
    const userParam = searchParams.get("user");
    const [userFilter, setUserFilter] = useState<string>(() => (all && userParam && /^\d+$/.test(userParam) ? userParam : ALL));
    const [status, setStatus] = useState<StatusFilter>("all");
    const [method, setMethod] = useState<MethodFilter>("all");
    const [search, setSearch] = useState("");
    const [rows, setRows] = useState<ApiCall[]>([]);
    const [dropped, setDropped] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const filterKey = `${tokenFilter}|${userFilter}`;
    const [rowsFor, setRowsFor] = useState<string | null>(null);
    const [rowsLimit, setRowsLimit] = useState(PAGE);
    const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
    const [paging, setPaging] = useState({ key: filterKey, limit: PAGE });
    const limit = paging.key === filterKey ? paging.limit : PAGE;
    const [users, setUsers] = useState<{ id: number; label: string }[]>([]);

    const fetchCalls = useCallback(async () => {
        const key = `${tokenFilter}|${userFilter}`;
        try {
            const qs = new URLSearchParams({ limit: String(limit) });
            if (all) qs.set("scope", "all");
            if (tokenFilter !== ALL) qs.set("token_id", tokenFilter);
            if (all && userFilter !== ALL) qs.set("user_id", userFilter);
            const res = await apiFetch(`/api/auth/tokens/calls?${qs.toString()}`);
            if (!res.ok) throw new Error(String(res.status));
            const page = (await res.json()) as ApiCallPage;
            setRows(page.calls);
            setDropped(page.dropped);
            setRowsLimit(limit);
            setFetchedAt(new Date());
            setFailed(false);
        } catch {
            setFailed(true);
        } finally {
            setRowsFor(key);
        }
    }, [all, tokenFilter, userFilter, limit]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            await fetchCalls();
            if (!cancelled) setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [fetchCalls]);

    useEffect(() => {
        if (!all) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch("/api/user/users");
                if (res.ok && !cancelled) {
                    const data: { users?: { id: number; username: string }[] } = await res.json();
                    setUsers((data.users ?? []).map((u) => ({ id: u.id, label: u.username })));
                }
            } catch {
                /* the filter stays empty */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [all]);

    const refresh = useCallback(async () => {
        setLoading(true);
        await fetchCalls();
        setLoading(false);
    }, [fetchCalls]);

    const entries = useMemo<ApiCallEntry[]>(() => withTimes(rows, fetchedAt ?? new Date(0), locale), [rows, fetchedAt, locale]);
    const filters = useMemo(() => ({ query: search, status, method }), [search, status, method]);
    const filtered = useMemo(() => filterApiCalls(entries, filters), [entries, filters]);
    const counts = useMemo(() => countApiCalls(entries, filters), [entries, filters]);
    const groups = useMemo<LabeledDayGroup<ApiCallEntry>[]>(() => labelDays(filtered, fetchedAt ?? new Date(0), t), [filtered, fetchedAt, t]);

    const initialLoading = rowsFor !== filterKey;
    const loadingMore = rowsLimit < limit;
    const noOlder = !loadingMore && rows.length < rowsLimit;
    const hasMore = !noOlder && rowsLimit < MAX_LIMIT;
    const loadMore = useCallback(() => setPaging({ key: filterKey, limit: Math.min(limit + PAGE, MAX_LIMIT) }), [filterKey, limit]);
    const filtering = search.trim() !== "" || status !== "all" || method !== "all";

    return {
        state: { all, rows: entries, filtered, groups, counts, loading, initialLoading, failed, hasMore, noOlder, loadingMore, tokenFilter, userFilter, users, status, method, search, filtering, dropped },
        actions: { refresh, setTokenFilter, setUserFilter, setStatus, setMethod, setSearch, loadMore },
    };
}
