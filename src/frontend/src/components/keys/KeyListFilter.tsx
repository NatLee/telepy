/**
 * 金鑰頁「我的金鑰」金鑰很多時：搜尋、分類（附數量）、排序，以及分頁（每頁筆數記在 localStorage
 * `telepy.keysPageSize`）。搜尋 / 分類 / 排序永遠對全部金鑰做，結果再分頁；條件一變就回第 1 頁。
 * 金鑰少時控制項不出現、順序不變。下方的裝置矩陣用同一份篩選結果當欄位。外觀對齊 DeviceFilter。
 * "My keys" with many keys: search, buckets with counts, sort, and pages (page size kept in localStorage
 * `telepy.keysPageSize`). Search / buckets / sort always run over every key and the result is paged; any change
 * goes back to page 1. With few keys nothing appears and the order is unchanged. The device matrix below uses the
 * same result for its columns. Looks like DeviceFilter.
 */
import React, { useCallback, useDeferredValue, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import type { UserKey } from "@/types/keys";
import { filterKeys, KEY_LIST_FILTER_FROM, type KeyListBucket, type KeyListSort } from "@/lib/userKeyList";
import { pageSlice } from "@/lib/pagination";
import { usePagination } from "@/hooks/usePagination";
import { Pagination } from "@/components/ui/pagination";

const BUCKETS: { value: KeyListBucket; label: TranslationKey }[] = [
    { value: "all", label: "keys.list.bucket.all" },
    { value: "placed", label: "keys.list.bucket.placed" },
    { value: "unplaced", label: "keys.list.bucket.unplaced" },
    { value: "unused", label: "keys.list.bucket.unused" },
];

const SORTS: { value: KeyListSort; label: TranslationKey }[] = [
    { value: "recent", label: "keys.list.sort.recent" },
    { value: "name", label: "keys.list.sort.name" },
    { value: "newest", label: "keys.list.sort.newest" },
];

export function useKeyListFilter(keys: UserKey[], devicesOf: (id: number) => number) {
    const { locale } = useI18n();
    const [query, setQuery] = useState("");
    const deferred = useDeferredValue(query);
    const [bucket, setBucket] = useState<KeyListBucket>("all");
    const [sort, setSort] = useState<KeyListSort>("recent");
    const showControls = keys.length >= KEY_LIST_FILTER_FROM;

    const result = useMemo(() => {
        // 金鑰少：不篩選、不排序（維持原本的順序）。/ Few keys: no filtering, original order.
        if (!showControls) return { keys, counts: { all: keys.length, placed: 0, unplaced: 0, unused: 0 }, bucket: "all" as KeyListBucket };
        const r = filterKeys(keys, deferred, bucket, sort, devicesOf, locale);
        // 選的分類變空了就退回全部。/ Fall back to "all" when the chosen bucket empties.
        if (bucket !== "all" && r.counts[bucket] === 0) return { ...filterKeys(keys, deferred, "all", sort, devicesOf, locale), bucket: "all" as KeyListBucket };
        return { ...r, bucket };
    }, [keys, deferred, bucket, sort, devicesOf, locale, showControls]);

    const filtering = showControls && (deferred.trim() !== "" || result.bucket !== "all");
    const pager = usePagination(result.keys.length, { storageKey: "telepy.keysPageSize", resetKey: `${deferred}|${result.bucket}|${sort}` });
    const visible = pageSlice(result.keys, pager.page, pager.size);
    const reset = useCallback(() => {
        setQuery("");
        setBucket("all");
    }, []);

    return {
        query,
        setQuery,
        bucket: result.bucket,
        setBucket,
        sort,
        setSort,
        counts: result.counts,
        /** 符合條件、排好序的全部金鑰（矩陣用）。/ Every matching key, sorted (used by the matrix). */
        keys: result.keys,
        /** 這一頁要畫出來的列。/ The rows on this page. */
        visible,
        pager,
        filtering,
        reset,
        showControls,
        total: keys.length,
    };
}

export type KeyListFilterState = ReturnType<typeof useKeyListFilter>;

export function KeyListFilterBar({ filter }: { filter: KeyListFilterState }) {
    const { t } = useI18n();
    if (!filter.showControls) return null;
    const shown = BUCKETS.filter((b) => b.value === "all" || filter.counts[b.value] > 0 || filter.bucket === b.value);
    return (
        <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] max-w-md flex-1">
                <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                    type="search"
                    value={filter.query}
                    onChange={(e) => filter.setQuery(e.target.value)}
                    placeholder={t("keys.list.search")}
                    aria-label={t("keys.list.search")}
                    className="h-8 pl-8"
                />
            </div>
            {shown.length > 1 && (
                <Segmented
                    size="sm"
                    value={filter.bucket}
                    onChange={filter.setBucket}
                    aria-label={t("keys.list.bucketAria")}
                    options={shown.map((b) => ({ value: b.value, label: `${t(b.label)} (${filter.counts[b.value]})` }))}
                />
            )}
            <NativeSelect value={filter.sort} onChange={(e) => filter.setSort(e.target.value as KeyListSort)} aria-label={t("keys.list.sort")} className="w-auto [&>select]:h-8">
                {SORTS.map((s) => (
                    <option key={s.value} value={s.value}>
                        {t(s.label)}
                    </option>
                ))}
            </NativeSelect>
        </div>
    );
}

/** 分頁列與「沒有符合的金鑰」。/ The pager and the no-match line. */
export function KeyListFilterFooter({ filter, anchor }: { filter: KeyListFilterState; anchor?: React.RefObject<HTMLElement | null> }) {
    const { t } = useI18n();
    if (filter.keys.length === 0 && filter.total > 0) {
        return (
            <p className="flex flex-wrap items-center justify-center gap-x-2 rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                {t("keys.rows.noMatch")}
                <Button variant="ghost" size="xs" className="text-primary hover:text-primary" onClick={filter.reset}>
                    {t("keys.rows.clearFilter")}
                </Button>
            </p>
        );
    }
    return <Pagination pager={filter.pager} anchor={anchor} className="mt-3" />;
}
