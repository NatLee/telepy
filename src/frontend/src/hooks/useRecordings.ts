/**
 * 終端機錄影清單：讀 `/api/recordings`（可只看一條隧道；`all` = 管理區的全站清單）、下載檔案、刪除。
 * 隧道設定變了（UPDATED-TUNNELS）就重抓。
 * Terminal recordings: list (optionally one tunnel; `all` = the admin section's site-wide list), fetch a file,
 * delete. Refetches when tunnels change.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";
import type { Recording } from "@/types/recording";
import type { ViewScope } from "@/components/layout/AdminViews";

export function useRecordings(tunnelId: number | null, scope: ViewScope = "mine") {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const [list, setList] = useState<Recording[] | null>(null);
    const [failed, setFailed] = useState(false);

    // 回傳有沒有拿到（重新整理鈕的勾勾）。/ Answers whether it arrived (the Refresh button's check).
    const reload = useCallback(async (): Promise<boolean> => {
        try {
            const qs = new URLSearchParams();
            if (tunnelId) qs.set("tunnel_id", String(tunnelId));
            if (scope === "all") qs.set("scope", "all");
            const res = await apiFetch(`/api/recordings${qs.size ? `?${qs.toString()}` : ""}`);
            if (!res.ok) {
                setFailed(true);
                return false;
            }
            setList(((await res.json()) as { recordings: Recording[] }).recordings);
            setFailed(false);
            return true;
        } catch {
            setFailed(true);
            return false;
        }
    }, [tunnelId, scope]);

    useEffect(() => {
        const first = setTimeout(() => void reload(), 0);
        return () => clearTimeout(first);
    }, [reload]);

    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.UPDATED_TUNNELS]: () => void reload(),
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_PRESENCE]: () => void reload(),
    });

    /** 讀錄影檔（文字）；失敗回 null 並提示。/ Fetch a recording's text; null (with a toast) on failure. */
    const fetchCast = async (r: Recording): Promise<string | null> => {
        const res = await apiFetch(`/api/recordings/${r.id}/cast`);
        if (res.ok) return res.text();
        showError(responseError(res, await readJson(res), t("recordings.loadFailed")));
        return null;
    };

    const download = async (r: Recording) => {
        const text = await fetchCast(r);
        if (text === null) return;
        const url = URL.createObjectURL(new Blob([text], { type: "application/x-asciicast" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `telepy-${r.tunnel.name ?? r.tunnel.id}-${r.id}.cast`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const remove = async (r: Recording): Promise<boolean> => {
        const res = await apiFetch(`/api/recordings/${r.id}`, { method: "DELETE" });
        if (res.ok) {
            showSuccess(t("recordings.deleted"));
            setList((prev) => prev?.filter((x) => x.id !== r.id) ?? prev);
            return true;
        }
        showError(responseError(res, await readJson(res), t("recordings.deleteFailed")));
        return false;
    };

    return { list, failed, reload, fetchCast, download, remove };
}
