"use client";

/**
 * 詳細資訊視窗的「裝置」段落：endpoint（位址 + 基本狀況）先用單筆 retrieve 帶來的，`DEVICE-FACTS-UPDATED` 時重抓；
 * 「立即重新整理」= `POST /api/reverse/server/{id}/probe`（owner / ADMIN，每分鐘一次；409 離線、429 太快）。
 * The details dialog's Device section: the endpoint from the single retrieve, refetched on `DEVICE-FACTS-UPDATED`;
 * "Refresh now" posts to `/probe` (owner / ADMIN, once a minute; 409 offline, 429 too soon).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { useNotificationHandlers } from "@/lib/websocket";
import { refreshWait } from "@/lib/deviceFacts";
import { NOTIFICATION_ACTIONS, type NotificationPayload } from "@/types/notification";
import type { TunnelEndpoint } from "@/types/tunnel";

export function useDeviceFacts(tunnelId: number | null, isOpen: boolean, initial: TunnelEndpoint | null | undefined) {
    const { t } = useI18n();
    const { showError, showSuccess } = useToast();
    const [fetched, setFetched] = useState<{ id: number; endpoint: TunnelEndpoint | null } | null>(null);
    const [busy, setBusy] = useState(false);
    // 這個視窗裡上次按「立即重新整理」的時間（冷卻倒數用）。/ When Refresh was last pressed here (cool-down).
    const [lastRefresh, setLastRefresh] = useState<number | null>(null);
    const [now, setNow] = useState(() => Date.now());

    const endpoint = fetched && fetched.id === tunnelId ? fetched.endpoint : initial ?? null;

    const reload = useCallback(async () => {
        if (!tunnelId) return;
        try {
            const res = await apiFetch(`/api/reverse/server/keys/${tunnelId}`);
            const body = await readJson<{ endpoint?: TunnelEndpoint | null }>(res);
            if (res.ok && body) setFetched({ id: tunnelId, endpoint: body.endpoint ?? null });
        } catch {
            // 下一次通知再試。/ The next notification tries again.
        }
    }, [tunnelId]);

    // 關掉就丟掉（下次打開用新的 retrieve）。/ Drop it on close; the next open starts from a fresh retrieve.
    useEffect(() => {
        if (!isOpen) setFetched(null);
    }, [isOpen]);

    const handlers = useMemo(
        () => ({
            [NOTIFICATION_ACTIONS.DEVICE_FACTS_UPDATED]: (msg: NotificationPayload) => {
                if (isOpen && msg.tunnel_id === tunnelId) void reload();
            },
        }),
        [isOpen, tunnelId, reload]
    );
    useNotificationHandlers(handlers);

    // 冷卻中每秒走一次倒數。/ Tick once a second during the cool-down.
    const wait = refreshWait(lastRefresh, now);
    useEffect(() => {
        if (wait <= 0) return;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [wait]);

    const refresh = useCallback(async () => {
        if (!tunnelId || busy) return;
        setBusy(true);
        const pressed = Date.now();
        try {
            const res = await apiFetch(`/api/reverse/server/${tunnelId}/probe`, { method: "POST" });
            const body = await readJson<TunnelEndpoint & { code?: string; retry_after?: number }>(res);
            if (res.ok && body) {
                setFetched({ id: tunnelId, endpoint: body });
                setLastRefresh(pressed);
                setNow(pressed);
                if (body.probe_error) showError(t("deviceFacts.refreshFailed", { error: body.probe_error }));
                else showSuccess(t("deviceFacts.refreshed"));
            } else if (body?.code === "device_offline") {
                showError(t("deviceFacts.offline"));
            } else if (body?.code === "too_soon") {
                setLastRefresh(pressed - (60 - (body.retry_after ?? 60)) * 1000);
                setNow(pressed);
                showError(t("deviceFacts.tooSoon", { seconds: body.retry_after ?? 60 }));
            } else {
                showError(responseError(res, body, t("deviceFacts.refreshFailed", { error: "" })));
            }
        } catch (e) {
            showError(e instanceof Error ? e.message : t("deviceFacts.refreshFailed", { error: "" }));
        } finally {
            setBusy(false);
        }
    }, [tunnelId, busy, showError, showSuccess, t]);

    return { endpoint, busy, refresh, wait };
}
