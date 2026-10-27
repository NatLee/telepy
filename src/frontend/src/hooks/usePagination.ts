/**
 * 清單分頁的狀態：目前頁（搜尋 / 篩選 / 排序一變就回第 1 頁，資料變少時自動夾回最後一頁）與每頁筆數
 * （每個清單各自記在 localStorage）。搜尋與篩選要在分頁之前對全部資料做，這裡只管切哪一段。
 * 依群組分段的清單用 `useSectionPages`：每段各自分頁（段標題永遠都在），每頁筆數共用。
 * State for a paged list: the current page (back to page 1 whenever the search / filter / sort changes, clamped
 * when the data shrinks) and the page size (remembered per list in localStorage). Search and filters run on
 * everything before paging; this only decides which slice to show. Lists split into group sections use
 * `useSectionPages`: each section pages on its own (every header stays visible) with one shared page size.
 */
import { useState } from "react";
import { useStoredChoice } from "@/hooks/useStoredChoice";
import { clampPage, pageCount, pageRange, PAGE_SIZES } from "@/lib/pagination";

export interface PaginationState {
    page: number;
    setPage: (page: number) => void;
    size: number;
    setSize: (size: number) => void;
    /** 可選的每頁筆數。/ The page size choices. */
    sizes: readonly number[];
    count: number;
    total: number;
    from: number;
    to: number;
}

interface PageOptions {
    storageKey: string;
    resetKey?: string;
    /** 每頁筆數的選項（預設 10 / 25 / 50 / 100；第一個是預設值）。/ Page size choices (default 10 / 25 / 50 / 100; the first is the default). */
    sizes?: readonly number[];
}

function state(page: number, total: number, size: number, sizes: readonly number[], setPage: (p: number) => void, setSize: (n: number) => void): PaginationState {
    const count = pageCount(total, size);
    const current = clampPage(page, count);
    return { page: current, setPage, size, setSize, sizes, count, total, ...pageRange(current, size, total) };
}

/** 記在 localStorage 的每頁筆數（不在選項裡就用第一個）。/ The stored page size (the first choice when unknown). */
function useSize(storageKey: string, sizes: readonly number[]): [number, (n: number) => void] {
    const [stored, setStored] = useStoredChoice(storageKey, sizes.map(String), String(sizes[0]));
    return [Number(stored), (n: number) => setStored(String(n))];
}

/** 條件變了就回到初始值（在算繪時比較，不多一輪 effect）。/ Reset to the initial value when the key changes (compared during render). */
function useResettable<T>(initial: T, resetKey: string): [T, (v: T | ((prev: T) => T)) => void] {
    const [value, setValue] = useState(initial);
    const [lastKey, setLastKey] = useState(resetKey);
    if (lastKey !== resetKey) {
        setLastKey(resetKey);
        setValue(initial);
        return [initial, setValue];
    }
    return [value, setValue];
}

export function usePagination(total: number, { storageKey, resetKey = "", sizes = PAGE_SIZES }: PageOptions): PaginationState {
    const [size, storeSize] = useSize(storageKey, sizes);
    const [page, setPage] = useResettable(1, resetKey);
    return state(page, total, size, sizes, setPage, (n) => {
        storeSize(n);
        setPage(1);
    });
}

/** 每段各自的頁碼，每頁筆數共用。`pager(key, total)` 給那一段的分頁狀態。/ Per-section pages with a shared size. */
export function useSectionPages({ storageKey, resetKey = "", sizes = PAGE_SIZES }: PageOptions) {
    const [size, storeSize] = useSize(storageKey, sizes);
    const [pages, setPages] = useResettable<Record<string, number>>({}, resetKey);
    const setSize = (n: number) => {
        storeSize(n);
        setPages({});
    };
    return {
        size,
        pager: (key: string, total: number) => state(pages[key] ?? 1, total, size, sizes, (p) => setPages((prev) => ({ ...prev, [key]: p })), setSize),
    };
}
