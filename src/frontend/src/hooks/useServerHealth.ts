/**
 * 管理區「伺服器狀態」的資料：`GET /api/site/health`（每次都重跑 doctor 的檢查，含審計鏈驗證，所以只在進頁面和
 * 按重新整理時抓，不輪詢）。
 * Data for the admin "Server health" page: `GET /api/site/health` (every call reruns the doctor checks, audit chain
 * included, so it loads on open and on Refresh only — no polling).
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { parseServerHealth, type ServerHealth } from "@/lib/serverHealth";

export function useServerHealth() {
    const [health, setHealth] = useState<ServerHealth | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState(false);

    // 回傳有沒有拿到（重新整理鈕的勾勾）。/ Answers whether it arrived (the Refresh button's check).
    const reload = useCallback(async (): Promise<boolean> => {
        setBusy(true);
        try {
            const res = await apiFetch("/api/site/health");
            const parsed = res.ok ? parseServerHealth(await readJson<unknown>(res)) : null;
            setHealth(parsed);
            setFailed(!parsed);
            return !!parsed;
        } catch {
            setFailed(true);
            return false;
        } finally {
            setBusy(false);
        }
    }, []);

    useEffect(() => {
        void reload();
    }, [reload]);

    return { health, failed, busy, reload };
}
