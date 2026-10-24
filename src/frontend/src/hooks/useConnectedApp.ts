/**
 * 一個已連接應用程式(OAuth grant)的詳細資料:授權內容、可用隧道、開著的 session、統計與最近的工具呼叫;
 * 可以關 session、撤銷授權。偏好設定的「已連接的應用程式」、MCP 頁與 AI 活動頁共用。
 * One connected app (OAuth grant): what it may do, which tunnels, open sessions, totals and recent tool
 * calls; close a session or revoke the app. Shared by the preferences tab, the MCP page and AI activity.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/types/notification";
import type { OAuthGrantDetail } from "@/types/oauth";
import type { AiSession } from "@/hooks/useAiActivityPage";

type Loaded = { id: number; detail: OAuthGrantDetail | null; failed: boolean };

export function useConnectedApp(grantId: number | null, onRevoked?: (id: number, name: string) => void) {
    const { t } = useI18n();
    const { showError, showSuccess } = useToast();
    // 結果連同它的 id 一起存:換一個 app 時不會先閃出上一個的資料。/ Keyed by id so another app never flashes stale data.
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [revoking, setRevoking] = useState(false);

    const fetchDetail = useCallback(async (id: number): Promise<Loaded> => {
        try {
            const res = await apiFetch(`/api/oauth/grants/${id}`);
            return res.ok ? { id, detail: await res.json(), failed: false } : { id, detail: null, failed: true };
        } catch {
            return { id, detail: null, failed: true };
        }
    }, []);

    useEffect(() => {
        if (grantId === null) return;
        let cancelled = false;
        (async () => {
            const next = await fetchDetail(grantId);
            if (!cancelled) setLoaded(next);
        })();
        return () => {
            cancelled = true;
        };
    }, [grantId, fetchDetail]);

    const reload = useCallback(async () => {
        if (grantId === null) return;
        setLoaded(await fetchDetail(grantId));
    }, [grantId, fetchDetail]);

    // 這個 app 的 session 開 / 關時重抓(session 列表與紀錄都會變)。/ Refresh when its sessions open or close.
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.AI_SESSION_OPENED]: () => {
            if (grantId !== null) reload();
        },
        [NOTIFICATION_ACTIONS.AI_SESSION_CLOSED]: () => {
            if (grantId !== null) reload();
        },
    });

    const closeSession = useCallback(
        async (s: AiSession) => {
            try {
                const res = await apiFetch(`/api/ai/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" });
                if (res.ok || res.status === 404) {
                    showSuccess(t("activity.sessionClosed", { app: s.client_name, tunnel: s.tunnel.name }));
                    await reload();
                } else {
                    showError(t("activity.sessionCloseFailed"));
                }
            } catch {
                showError(t("activity.sessionCloseFailed"));
            }
        },
        [reload, showError, showSuccess, t]
    );

    const revoke = useCallback(async () => {
        const d = loaded?.id === grantId ? loaded?.detail : null;
        if (!d) return false;
        setRevoking(true);
        try {
            const res = await apiFetch(`/api/oauth/grants/${d.id}`, { method: "DELETE" });
            if (res.ok || res.status === 404) {
                showSuccess(t("prefs.appRevoked", { name: d.client_name }));
                onRevoked?.(d.id, d.client_name);
                return true;
            }
            showError(t("prefs.appRevokeFailed"));
        } catch {
            showError(t("prefs.appRevokeFailed"));
        } finally {
            setRevoking(false);
        }
        return false;
    }, [grantId, loaded, onRevoked, showError, showSuccess, t]);

    const current = loaded && loaded.id === grantId ? loaded : null;
    return {
        detail: current?.detail ?? null,
        loading: grantId !== null && current === null,
        failed: current?.failed ?? false,
        revoking,
        reload,
        closeSession,
        revoke,
    };
}
