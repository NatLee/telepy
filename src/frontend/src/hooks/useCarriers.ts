/**
 * 伺服器健康頁的載體面板資料：`GET /api/site/carriers`、立即檢查（`POST …/check`）、更新（`POST …/update`，回這次做了什麼）、
 * 自動更新開關（網站設定 `carrier_auto_update`）。別處（自動更新、另一個管理員）換了載體時跟著重抓。
 * Data for the Server health page's carriers panel: the view, "check now", "update" (answers the run) and the
 * auto-update switch (the `carrier_auto_update` site setting). Reloads when carriers change elsewhere.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { parseCarriers, type CarrierRun, type CarriersView } from "@/lib/carriers";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";

export type CarrierAction = "check" | "update" | "auto";

export function useCarriers() {
    const [view, setView] = useState<CarriersView | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState<CarrierAction | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (): Promise<boolean> => {
        try {
            const res = await apiFetch("/api/site/carriers");
            const v = res.ok ? parseCarriers(await readJson<unknown>(res)) : null;
            if (v) setView(v);
            setFailed(!v);
            return !!v;
        } catch {
            setFailed(true);
            return false;
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.CARRIERS_UPDATED]: () => void load(),
        [NOTIFICATION_ACTIONS.CARRIERS_UPDATE_FAILED]: () => void load(),
    });

    /** 回錯誤訊息（409 busy 之類）或 null。/ The error message (409 busy…) or null. */
    const post = async (path: string, body: unknown): Promise<unknown | null> => {
        setError(null);
        const res = await apiFetch(path, { method: "POST", body: JSON.stringify(body) });
        const json = await readJson<Record<string, unknown>>(res);
        if (!res.ok) {
            setError(typeof json?.error === "string" ? json.error : `HTTP ${res.status}`);
            return null;
        }
        return json;
    };

    const check = async (): Promise<boolean> => {
        setBusy("check");
        try {
            const v = parseCarriers(await post("/api/site/carriers/check", {}));
            if (v) setView(v);
            return !!v;
        } finally {
            setBusy(null);
        }
    };

    /** 更新（沒給 = 全部平台）；回這次做了什麼。/ Update (none given = every platform); answers the run. */
    const update = async (targets?: string[]): Promise<CarrierRun | null> => {
        setBusy("update");
        try {
            const json = (await post("/api/site/carriers/update", targets ? { targets } : {})) as { carriers?: unknown } | null;
            const v = parseCarriers(json?.carriers);
            if (v) setView(v);
            return v?.last_run ?? null;
        } finally {
            setBusy(null);
        }
    };

    const setAuto = async (on: boolean): Promise<boolean> => {
        setBusy("auto");
        try {
            const ok = (await post("/api/site/settings", { carrier_auto_update: on })) !== null;
            if (ok) await load();
            return ok;
        } finally {
            setBusy(null);
        }
    };

    return { view, failed, busy, error, load, check, update, setAuto };
}
