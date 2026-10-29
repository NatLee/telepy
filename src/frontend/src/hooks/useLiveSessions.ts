/**
 * 即時 session：讀 `/api/sessions`（`all` = 管理區的全站清單）、結束一個。有人進出（UPDATE-TUNNEL-PRESENCE）、
 * AI session 開關或被結束時重抓，另外每 15 秒抓一次（管理區看得到但收不到通知的隧道）。
 * Live sessions: read `/api/sessions` (`all` = the admin section's site-wide list) and end one. Refetches on
 * presence / AI session / session-ended notifications and every 15 seconds (the admin section sees tunnels it gets
 * no notifications for).
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";
import type { LiveSession } from "@/types/liveSession";
import type { ViewScope } from "@/components/layout/AdminViews";

const POLL_MS = 15_000;

export function useLiveSessions(scope: ViewScope = "mine") {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const [sessions, setSessions] = useState<LiveSession[] | null>(null);
    const [failed, setFailed] = useState(false);

    // 回傳有沒有拿到（重新整理鈕的勾勾）。/ Answers whether it arrived (the Refresh button's check).
    const reload = useCallback(async (): Promise<boolean> => {
        try {
            const res = await apiFetch(scope === "all" ? "/api/sessions?scope=all" : "/api/sessions");
            if (!res.ok) {
                setFailed(true);
                return false;
            }
            const data = (await res.json()) as { sessions: LiveSession[] };
            setSessions(data.sessions);
            setFailed(false);
            return true;
        } catch {
            setFailed(true);
            return false;
        }
    }, [scope]);

    useEffect(() => {
        // 進頁面與每 15 秒抓一次（setState 在非同步回呼裡）。/ Load on mount and every 15 s.
        const first = setTimeout(() => void reload(), 0);
        const timer = setInterval(() => void reload(), POLL_MS);
        return () => {
            clearTimeout(first);
            clearInterval(timer);
        };
    }, [reload]);

    const refetch = () => void reload();
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_PRESENCE]: refetch,
        [NOTIFICATION_ACTIONS.AI_SESSION_OPENED]: refetch,
        [NOTIFICATION_ACTIONS.AI_SESSION_CLOSED]: refetch,
        [NOTIFICATION_ACTIONS.SESSION_ENDED]: refetch,
    });

    /** 結束一個 session；成功回 true。/ End a session; true on success. */
    const end = async (s: LiveSession): Promise<boolean> => {
        const res = await apiFetch(`/api/sessions/${s.id}`, { method: "DELETE" });
        if (res.ok || res.status === 404) {
            // 404 = 剛好自己結束了，結果一樣。/ 404 = it just ended by itself; same outcome.
            showSuccess(t("sessions.ended"));
            setSessions((prev) => prev?.filter((x) => x.id !== s.id) ?? prev);
            return true;
        }
        showError(responseError(res, await readJson(res), t("sessions.endFailed")));
        return false;
    };

    return { sessions, failed, reload, end };
}
