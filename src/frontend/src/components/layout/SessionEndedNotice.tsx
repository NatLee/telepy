"use client";

/**
 * 有人從即時 session 頁結束了你的 session：任何頁面都跳一個提醒（說是誰、哪種）。
 * Someone ended one of your sessions from the live sessions page: a heads-up on any page (who, and which kind).
 */
import { useToast } from "@/components/ui/Toast";
import { PRESENCE_KINDS } from "@/components/tunnels/TunnelPresence";
import { useI18n } from "@/lib/i18n";
import { featureKey } from "@/lib/features";
import type { TranslationKey } from "@/locales/en";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { useNotificationHandlers } from "@/lib/websocket";

export function SessionEndedNotice() {
    const { t } = useI18n();
    const { showToast } = useToast();
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.SESSION_ENDED]: (msg) => {
            const kind = PRESENCE_KINDS[String(msg.kind ?? "")];
            const kindLabel = kind ? t(kind.label) : String(msg.kind ?? "");
            // 管理員把這個功能關掉了（`feature` = 功能 id）。/ An admin turned the feature off (`feature` = its id).
            if (typeof msg.feature === "string") {
                showToast(t("access.sessionEndedToast", { feature: t(`access.f.${featureKey(msg.feature)}` as TranslationKey), kind: kindLabel }), "warning");
                return;
            }
            showToast(t("sessions.endedToast", { by: String(msg.by ?? ""), kind: kind ? t(kind.label) : String(msg.kind ?? "") }), "warning");
        },
        // 有人開始看你的終端機（停止的那一則不吵你，終端機裡已經有一行）。/ Someone started watching your terminal.
        [NOTIFICATION_ACTIONS.TERMINAL_WATCHED]: (msg) => {
            if (msg.watching !== true) return;
            showToast(t("watch.toast", { by: String(msg.by ?? ""), tunnel: String(msg.tunnel_name ?? "") }), "info");
        },
    });
    return null;
}
