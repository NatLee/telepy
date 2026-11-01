/**
 * 伺服器健康頁「IP 與網卡廠商資料」面板的資料：`GET /api/site/datasets`、立即更新（`POST …/update`，回這次做了什麼）、
 * 自動更新開關（網站設定 `datasets_auto_update`）。
 * Data for the Server health page's "IP and vendor data" panel: the view, "update now" (answers the run) and the
 * auto-update switch (the `datasets_auto_update` site setting).
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { parseDatasets, type DatasetId, type DatasetRun, type DatasetsView } from "@/lib/datasets";

export type DatasetAction = "update" | "auto";

export function useDatasets() {
    const [view, setView] = useState<DatasetsView | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState<{ action: DatasetAction; items?: DatasetId[] } | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (): Promise<boolean> => {
        try {
            const res = await apiFetch("/api/site/datasets");
            const v = res.ok ? parseDatasets(await readJson<unknown>(res)) : null;
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

    /** 回 JSON，或 null（錯誤訊息放進 `error`）。/ The JSON, or null with the message in `error`. */
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

    /** 立即更新（沒給 = 三項都看）；回這次做了什麼。/ Update now (none given = all three); answers the run. */
    const update = async (items?: DatasetId[]): Promise<DatasetRun | null> => {
        setBusy({ action: "update", items });
        try {
            const json = (await post("/api/site/datasets/update", items ? { items } : {})) as { datasets?: unknown } | null;
            const v = parseDatasets(json?.datasets);
            if (v) setView(v);
            return v?.last_run ?? null;
        } finally {
            setBusy(null);
        }
    };

    const setAuto = async (on: boolean): Promise<boolean> => {
        setBusy({ action: "auto" });
        try {
            const ok = (await post("/api/site/settings", { datasets_auto_update: on })) !== null;
            if (ok) await load();
            return ok;
        } finally {
            setBusy(null);
        }
    };

    return { view, failed, busy, error, load, update, setAuto };
}
