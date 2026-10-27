/**
 * 裝置很多時的共用篩選：搜尋（裝置名稱 / 帳號）＋「在清單上 / 需要處理 / 全部」（附數量）＋分頁（每頁筆數記在
 * `telepy.deviceListPageSize`；以前是「全部顯示」，一展開視窗就很長）。金鑰詳情的「裝置」、新增金鑰的「同時裝到」、
 * 金鑰群組的「授予給」與裝置矩陣都用它（矩陣自己分頁）；裝置少時整排控制項不出現。
 * Shared filtering for long device lists: search (device name / account), "on the list / needs attention / all"
 * with counts, and pages (page size in `telepy.deviceListPageSize`; it used to be "show all", which made the dialog
 * long). Used by key details, the add dialog, the key-group grant dialog and the device matrix (which pages
 * itself); the controls only appear once there are enough devices.
 */
import React, { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Pagination } from "@/components/ui/pagination";
import { usePagination } from "@/hooks/usePagination";
import { pageSlice } from "@/lib/pagination";
import { useI18n } from "@/lib/i18n";
import type { KeyDevice, KeyTarget } from "@/types/keys";

export type DeviceFilterMode = "all" | "on" | "problems";

/** 這麼多台以上才顯示搜尋 / 篩選。/ Show the controls from this many devices on. */
export const FILTER_FROM = 7;

/** 一把金鑰在一台裝置上需要處理（失敗，或裝置在線卻還沒裝上）。/ A key needs attention on a device. */
export function needsAttention(targets: KeyTarget[] | undefined, online: boolean): boolean {
    return !!targets?.some((t) => t.status === "error" || (t.status === "pending" && online));
}

export function useDeviceFilter<T>(
    items: T[],
    opts: {
        device: (item: T) => KeyDevice;
        isOn?: (item: T) => boolean;
        isProblem?: (item: T) => boolean;
        initial?: DeviceFilterMode;
        /** false = 不分頁（裝置矩陣自己分頁）。/ false = no pages (the device matrix pages itself). */
        collapse?: boolean;
    }
) {
    const { device, isOn, isProblem } = opts;
    const [query, setQuery] = useState("");
    const [mode, setMode] = useState<DeviceFilterMode>(opts.initial ?? "all");

    const counts = useMemo(
        () => ({
            all: items.length,
            on: isOn ? items.filter(isOn).length : 0,
            problems: isProblem ? items.filter(isProblem).length : 0,
        }),
        [items, isOn, isProblem]
    );
    // 選的分類變空了就退回全部（例如最後一個問題解決了）。/ Fall back to "all" when the chosen bucket empties.
    const effective: DeviceFilterMode = mode !== "all" && counts[mode] === 0 ? "all" : mode;

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return items.filter((it) => {
            if (effective === "on" && isOn && !isOn(it)) return false;
            if (effective === "problems" && isProblem && !isProblem(it)) return false;
            if (!q) return true;
            const d = device(it);
            return d.host_friendly_name.toLowerCase().includes(q) || d.accounts.some((a) => a.toLowerCase().includes(q));
        });
    }, [items, query, effective, isOn, isProblem, device]);

    const paged = opts.collapse !== false;
    const pager = usePagination(filtered.length, { storageKey: "telepy.deviceListPageSize", resetKey: `${query}|${effective}` });
    const visible = paged ? pageSlice(filtered, pager.page, pager.size) : filtered;
    return {
        query,
        setQuery,
        mode: effective,
        setMode,
        counts,
        filtered,
        visible,
        /** 分頁狀態（不分頁時 null）。/ The pager (null without pages). */
        pager: paged ? pager : null,
        showControls: items.length >= FILTER_FROM,
    };
}

export type DeviceFilterState = ReturnType<typeof useDeviceFilter>;

/** 搜尋框＋分類（裝置少時不顯示）。`onLabel` 是「在清單上」那一格的字。/ Search box + buckets. */
export function DeviceFilterBar({ filter, onLabel, modes = ["on", "problems", "all"] }: { filter: DeviceFilterState; onLabel?: string; modes?: DeviceFilterMode[] }) {
    const { t } = useI18n();
    if (!filter.showControls) return null;
    const label: Record<DeviceFilterMode, string> = {
        on: `${onLabel ?? t("keys.filter.on")} (${filter.counts.on})`,
        problems: `${t("keys.filter.problems")} (${filter.counts.problems})`,
        all: `${t("keys.filter.all")} (${filter.counts.all})`,
    };
    const shown = modes.filter((m) => m === "all" || filter.counts[m] > 0);
    return (
        <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] flex-1">
                <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                    type="search"
                    value={filter.query}
                    onChange={(e) => filter.setQuery(e.target.value)}
                    placeholder={t("keys.filter.search")}
                    aria-label={t("keys.filter.search")}
                    className="h-8 pl-8"
                />
            </div>
            {shown.length > 1 && (
                <Segmented
                    size="sm"
                    value={filter.mode}
                    onChange={filter.setMode}
                    aria-label={t("keys.filter.aria")}
                    options={shown.map((m) => ({ value: m, label: label[m] }))}
                />
            )}
        </div>
    );
}

/** 分頁列與「沒有符合的裝置」。/ The pager and the no-match line. */
export function DeviceFilterFooter({ filter }: { filter: DeviceFilterState }) {
    const { t } = useI18n();
    if (filter.filtered.length === 0 && filter.counts.all > 0) {
        return <p className="py-3 text-center text-sm text-muted-foreground">{t("keys.filter.noMatch")}</p>;
    }
    return filter.pager ? <Pagination pager={filter.pager} /> : null;
}
