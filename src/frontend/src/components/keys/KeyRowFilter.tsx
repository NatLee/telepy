/**
 * 裝置金鑰面板在 authorized_keys 很長時的工具：搜尋＋帳號＋分類（附數量）放在 Modal toolbar（捲動時一直看得到）、
 * 每個帳號先顯示幾列再「顯示更多」、批次勾選要從裝置移除的金鑰。列少時整排控制項不出現。外觀對齊 DeviceFilter。
 * Tools for long authorized_keys files in the device-key panel: search + account + buckets with counts in the
 * Modal toolbar (visible while the body scrolls), per-account paging, and bulk selection for removal. The
 * controls only appear once there are enough rows. Looks like DeviceFilter.
 */
import React, { useCallback, useDeferredValue, useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import type { ViewAccount, ViewRow } from "@/types/keys";
import {
    filterAccounts,
    groupSelection,
    isRemovable,
    liveSelection,
    ROW_FILTER_FROM,
    ROWS_COLLAPSED,
    ROWS_STEP,
    selectionKey,
    SHOW_ALL_MAX,
    visibleCount,
    type RowBucket,
} from "@/lib/keyRows";

const BUCKETS: { value: RowBucket; label: TranslationKey }[] = [
    { value: "all", label: "keys.rows.bucket.all" },
    { value: "list", label: "keys.rows.bucket.list" },
    { value: "other", label: "keys.rows.bucket.other" },
    { value: "attention", label: "keys.rows.bucket.attention" },
];

export function useRowFilter(accounts: ViewAccount[], online: boolean) {
    const [query, setQuery] = useState("");
    const deferred = useDeferredValue(query);
    const [bucket, setBucket] = useState<RowBucket>("all");
    const [account, setAccount] = useState("");

    const names = useMemo(() => accounts.map((a) => a.username), [accounts]);
    // 選的帳號不見了就退回全部。/ Fall back to every account when the chosen one is gone.
    const effectiveAccount = account && names.includes(account) ? account : "";
    const scoped = useMemo(() => (effectiveAccount ? accounts.filter((a) => a.username === effectiveAccount) : accounts), [accounts, effectiveAccount]);
    const result = useMemo(() => {
        const r = filterAccounts(scoped, deferred, bucket, online);
        // 選的分類變空了（例如最後一個問題解決了）就退回全部。/ Fall back to "all" when the chosen bucket empties.
        return bucket !== "all" && r.counts[bucket] === 0 ? { ...filterAccounts(scoped, deferred, "all", online), bucket: "all" as RowBucket } : { ...r, bucket };
    }, [scoped, deferred, bucket, online]);
    const total = useMemo(() => accounts.reduce((n, a) => n + a.rows.length, 0), [accounts]);
    const filtering = deferred.trim() !== "" || result.bucket !== "all";

    const reset = useCallback(() => {
        setQuery("");
        setBucket("all");
        setAccount("");
    }, []);

    return {
        query,
        setQuery,
        reset,
        bucket: result.bucket,
        setBucket,
        account: effectiveAccount,
        setAccount,
        names,
        counts: result.counts,
        accounts: result.accounts,
        filtering,
        /** 篩選條件一變，各帳號的「顯示更多」就重來。/ Paging restarts whenever the filter changes. */
        resetKey: `${deferred}\n${result.bucket}\n${effectiveAccount}`,
        showControls: total >= ROW_FILTER_FROM,
    };
}

export type RowFilterState = ReturnType<typeof useRowFilter>;

/** 搜尋框＋帳號＋分類（列少時不顯示）。/ Search + account + buckets. */
export function RowFilterBar({ filter }: { filter: RowFilterState }) {
    const { t } = useI18n();
    if (!filter.showControls) return null;
    const shown = BUCKETS.filter((b) => b.value === "all" || filter.counts[b.value] > 0 || filter.bucket === b.value);
    return (
        <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] flex-1">
                <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                    type="search"
                    value={filter.query}
                    onChange={(e) => filter.setQuery(e.target.value)}
                    placeholder={t("keys.rows.search")}
                    aria-label={t("keys.rows.search")}
                    className="h-8 pl-8"
                />
            </div>
            {filter.names.length > 1 && (
                <NativeSelect value={filter.account} onChange={(e) => filter.setAccount(e.target.value)} aria-label={t("keys.rows.account")} className="w-auto [&>select]:h-8">
                    <option value="">{t("keys.rows.allAccounts")}</option>
                    {filter.names.map((n) => (
                        <option key={n} value={n}>
                            {n}
                        </option>
                    ))}
                </NativeSelect>
            )}
            {shown.length > 1 && (
                <Segmented
                    size="sm"
                    value={filter.bucket}
                    onChange={filter.setBucket}
                    aria-label={t("keys.rows.bucketAria")}
                    options={shown.map((b) => ({ value: b.value, label: `${t(b.label)} (${filter.counts[b.value]})` }))}
                />
            )}
        </div>
    );
}

/** 一個帳號要顯示幾列；篩選條件變了就重來（搜尋時一次多給一些）。/ How many rows of one account to render. */
export function useRowLimit(total: number, resetKey: string, filtering: boolean) {
    const initial = filtering ? ROWS_STEP : ROWS_COLLAPSED;
    const [state, setState] = useState({ key: resetKey, limit: initial });
    const limit = state.key === resetKey ? state.limit : initial;
    const shown = visibleCount(total, limit);
    return {
        shown,
        hidden: total - shown,
        more: () => setState({ key: resetKey, limit: shown + ROWS_STEP }),
        all: () => setState({ key: resetKey, limit: Infinity }),
    };
}

/** 帳號卡底部：「顯示 10 / 214 列 · 再顯示 50 列 · 全部顯示」。/ The per-account "show more" row. */
export function RowsMore({ shown, total, onMore, onAll }: { shown: number; total: number; onMore: () => void; onAll: () => void }) {
    const { t } = useI18n();
    if (shown >= total) return null;
    const hidden = total - shown;
    return (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border/70 px-3.5 py-1.5">
            <span className="text-xs text-muted-foreground">{t("keys.rows.showing", { shown, total })}</span>
            <span className="flex items-center gap-1">
                <Button type="button" variant="ghost" size="xs" className="text-primary hover:text-primary" onClick={onMore}>
                    <ChevronDown /> {t("keys.rows.showMore", { count: Math.min(ROWS_STEP, hidden) })}
                </Button>
                {total <= SHOW_ALL_MAX && hidden > ROWS_STEP && (
                    <Button type="button" variant="ghost" size="xs" onClick={onAll}>
                        {t("keys.rows.showAll", { count: total })}
                    </Button>
                )}
            </span>
        </div>
    );
}

/** 批次移除的勾選（帳號 + 指紋）；重新整理後消失的自動剔除。/ Bulk selection, pruned when rows go away. */
export function useRowSelection(accounts: ViewAccount[]) {
    const [selected, setSelected] = useState<Set<string>>(() => new Set());
    const live = useMemo(() => liveSelection(selected, accounts), [selected, accounts]);

    const isSelected = useCallback((username: string, row: ViewRow) => !!row.fingerprint && live.has(selectionKey(username, row.fingerprint)), [live]);
    const toggle = useCallback(
        (username: string, rows: ViewRow[], on: boolean) =>
            setSelected((prev) => {
                const next = new Set(liveSelection(prev, accounts));
                for (const r of rows) {
                    if (!isRemovable(r)) continue;
                    const k = selectionKey(username, r.fingerprint!);
                    if (on) next.add(k);
                    else next.delete(k);
                }
                return next;
            }),
        [accounts]
    );
    const clear = useCallback(() => setSelected(new Set()), []);
    /** 帳號 → 指紋（批次移除一個帳號一個請求）。/ Account → fingerprints. */
    const groups = useMemo(() => groupSelection(live), [live]);
    return { count: live.size, isSelected, toggle, clear, groups };
}

export type RowSelection = ReturnType<typeof useRowSelection>;

/** 帳號卡標題列的「全選 N 把」（只算符合篩選、能移除的）。/ "Select all N" in an account header. */
export function SelectAllRemovable({ username, rows, selection }: { username: string; rows: ViewRow[]; selection: RowSelection }) {
    const { t } = useI18n();
    const removable = useMemo(() => rows.filter(isRemovable), [rows]);
    if (removable.length < 2) return null;
    const picked = removable.filter((r) => selection.isSelected(username, r)).length;
    return (
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <input
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={picked === removable.length}
                ref={(el) => {
                    if (el) el.indeterminate = picked > 0 && picked < removable.length;
                }}
                onChange={(e) => selection.toggle(username, removable, e.target.checked)}
            />
            {t("keys.rows.selectAll", { count: removable.length })}
        </label>
    );
}
