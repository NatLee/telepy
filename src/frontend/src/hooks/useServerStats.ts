/**
 * 伺服器健康頁的即時狀態：`GET /api/site/health/stats`，掛上時與 reloadKey 變了時抓；重抓時保留舊資料。
 * 404 = 舊的後端沒有這個端點 → `missing`（整塊不畫）。
 * Live status for the Server health page: fetched on mount and whenever `reloadKey` changes, keeping the old data
 * while it reloads. A 404 = an older backend without the endpoint → `missing` (render nothing).
 */
import { useEffect, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { parseServerStats, type ServerStats } from "@/lib/serverStats";

export interface ServerStatsState {
    stats: ServerStats | null;
    loading: boolean;
    failed: boolean;
    missing: boolean;
}

interface Loaded {
    /** 這份結果是哪一個 reloadKey 抓的；不等於目前的 = 還在載入。/ The reloadKey this answer belongs to; another one = loading. */
    key: number | null;
    stats: ServerStats | null;
    failed: boolean;
    missing: boolean;
}

export function useServerStats(reloadKey: number): ServerStatsState {
    const [loaded, setLoaded] = useState<Loaded>({ key: null, stats: null, failed: false, missing: false });

    useEffect(() => {
        let alive = true;
        (async () => {
            let next: Omit<Loaded, "key" | "stats"> & { stats?: ServerStats | null };
            try {
                const res = await apiFetch("/api/site/health/stats");
                if (res.status === 404) next = { stats: null, failed: false, missing: true };
                else {
                    const stats = res.ok ? parseServerStats(await readJson(res)) : null;
                    // 失敗時保留上一份。/ On failure keep the previous answer.
                    next = stats ? { stats, failed: false, missing: false } : { failed: true, missing: false };
                }
            } catch {
                next = { failed: true, missing: false };
            }
            if (!alive) return;
            setLoaded((prev) => ({ key: reloadKey, stats: next.stats === undefined ? prev.stats : next.stats, failed: next.failed, missing: next.missing }));
        })();
        return () => {
            alive = false;
        };
    }, [reloadKey]);

    return { stats: loaded.stats, loading: loaded.key !== reloadKey, failed: loaded.failed, missing: loaded.missing };
}
