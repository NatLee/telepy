"use client";

/**
 * 有人從即時 session 頁結束了你的 session：任何頁面都跳一個提醒（說是誰、哪種）。
 * Someone ended one of your sessions from the live sessions page: a heads-up on any page (who, and which kind).
 */
import { useToast } from "@/components/ui/Toast";
import { PRESENCE_KINDS } from "@/components/tunnels/TunnelPresence";
import { useI18n } from "@/lib/i18n";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { useNotificationHandlers } from "@/lib/websocket";

export function SessionEndedNotice() {
    const { t } = useI18n();
    const { showToast } = useToast();
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.SESSION_ENDED]: (msg) => {
            const kind = PRESENCE_KINDS[String(msg.kind ?? "")];
            showToast(t("sessions.endedToast", { by: String(msg.by ?? ""), kind: kind ? t(kind.label) : String(msg.kind ?? "") }), "warning");
        },
    });
    return null;
}
