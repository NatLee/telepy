/**
 * 即時 session：讀 `/api/sessions`、結束一個。有人進出（UPDATE-TUNNEL-PRESENCE / RUSTDESK-DEVICES-UPDATED）、AI session 開關或被結束時重抓，
 * 另外每 15 秒抓一次（看得到但收不到通知的隧道，例如管理員看別人的）。
 * Live sessions: read `/api/sessions` and end one. Refetches on presence / AI session / session-ended notifications
 * and every 15 seconds (admins see tunnels they get no notifications for).
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";
import type { LiveSession } from "@/types/liveSession";

const POLL_MS = 15_000;

export function useLiveSessions() {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const [sessions, setSessions] = useState<LiveSession[] | null>(null);
    const [failed, setFailed] = useState(false);

    const reload = useCallback(async () => {
        try {
            const res = await apiFetch("/api/sessions");
            if (!res.ok) {
                setFailed(true);
                return;
            }
            const data = (await res.json()) as { sessions: LiveSession[] };
            setSessions(data.sessions);
            setFailed(false);
        } catch {
            setFailed(true);
        }
    }, []);

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
        // RustDesk 伺服器裝置沒有隧道：開關 session 時擁有者收到這個。/ RustDesk-server devices have no tunnel presence.
        [NOTIFICATION_ACTIONS.RUSTDESK_DEVICES_UPDATED]: refetch,
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
