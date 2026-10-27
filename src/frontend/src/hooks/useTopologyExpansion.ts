/**
 * 網路拓撲樹的展開狀態：哪些裝置展開（localStorage `telepy.networkExpanded`；沒選過時依 `defaultExpanded`）、
 * 哪些資料夾（通道群組）收起來（`telepy.networkFolders`），以及全部展開 / 全部收合。網址的 ?tunnel= 那台一定展開。
 * Expansion state of the network topology tree: which devices are expanded (localStorage `telepy.networkExpanded`;
 * `defaultExpanded` without a choice), which folders (tunnel groups) are collapsed (`telepy.networkFolders`), and
 * expand all / collapse all. The URL's ?tunnel= device is always expanded.
 */
import { useCallback, useMemo, useState } from "react";
import { defaultExpanded } from "@/lib/topology";
import type { TopologyExpansion } from "@/components/network/TopologyTree";

const EXPANDED_KEY = "telepy.networkExpanded";
const FOLDERS_KEY = "telepy.networkFolders";

function read(key: string): (string | number)[] | null {
    try {
        const v = JSON.parse(localStorage.getItem(key) ?? "null");
        return Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
}

function write(key: string, values: Iterable<string | number>) {
    try {
        localStorage.setItem(key, JSON.stringify([...values]));
    } catch {
        /* 這次就不記。/ Not remembered this time. */
    }
}

export function useTopologyExpansion(devices: { id: number; hosts: unknown[] }[], focus: string | null) {
    // 網路頁只在瀏覽器端算繪（Suspense 內），直接讀 localStorage。/ Client-only page (inside Suspense).
    const [stored, setStored] = useState<Set<number> | null>(() => {
        const v = read(EXPANDED_KEY);
        return v ? new Set(v.map(Number)) : null;
    });
    const [folders, setFolders] = useState<Set<string>>(() => new Set((read(FOLDERS_KEY) ?? []).map(String)));
    const focusId = focus !== null && /^\d+$/.test(focus) ? Number(focus) : null;
    const expanded = useMemo(() => stored ?? defaultExpanded(devices, focusId), [stored, devices, focusId]);

    const setExpanded = useCallback((next: Set<number>) => {
        setStored(next);
        write(EXPANDED_KEY, next);
    }, []);

    const api: TopologyExpansion & { expandAll: (ids: number[]) => void; collapseAll: () => void; anyExpanded: boolean } = {
        isExpanded: (id) => expanded.has(id) || id === focusId,
        toggle: (id) => {
            const next = new Set(expanded);
            if (next.has(id) || id === focusId) next.delete(id);
            else next.add(id);
            setExpanded(next);
        },
        isFolderCollapsed: (key) => folders.has(key),
        toggleFolder: (key) => {
            setFolders((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                write(FOLDERS_KEY, next);
                return next;
            });
        },
        expandAll: (ids) => {
            setExpanded(new Set([...expanded, ...ids]));
            setFolders(new Set());
            write(FOLDERS_KEY, []);
        },
        collapseAll: () => setExpanded(new Set()),
        anyExpanded: expanded.size > 0,
    };
    return api;
}
