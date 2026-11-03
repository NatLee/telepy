"use client";

/**
 * 頁面在頁首麵包屑最後加一段（例如通道頁面的通道名稱）：掛上時設、卸下時清。頁首用 `usePageCrumbValue` 讀。
 * A page adds a last crumb to the header breadcrumb (e.g. the tunnel's name on its page): set while mounted, cleared on
 * unmount. The header reads it with `usePageCrumbValue`.
 */
import { useEffect, useSyncExternalStore } from "react";

let crumb: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
};

export function usePageCrumb(label: string | null | undefined) {
    useEffect(() => {
        crumb = label || null;
        emit();
        return () => {
            crumb = null;
            emit();
        };
    }, [label]);
}

export function usePageCrumbValue(): string | null {
    return useSyncExternalStore(subscribe, () => crumb, () => null);
}
