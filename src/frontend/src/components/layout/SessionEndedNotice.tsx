"use client";

/**
 * 有人從即時 session 頁結束了你的 session、功能被關掉、或存取被拿掉：任何頁面都跳一個提醒（說是誰 / 為什麼、哪種）。
 * Someone ended one of your sessions from the live sessions page, a feature was turned off, or your access was
 * removed: a heads-up on any page (who / why, and which kind).
 */
import { useToast } from "@/components/ui/Toast";
import { PRESENCE_KINDS } from "@/components/tunnels/TunnelPresence";
import { useI18n } from "@/lib/i18n";
import { featureKey } from "@/lib/features";
import { endedNotice, lostToast } from "@/lib/liveSessions";
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
            const n = endedNotice(msg);
            // 管理員把這個功能關掉了（`feature` = 功能 id）；斷線保留中的 shell 另外說。
            // An admin turned the feature off (`feature` = its id); a kept (detached) shell says so.
            if (n.kind === "feature") {
                const feature = t(`access.f.${featureKey(n.feature)}` as TranslationKey);
                showToast(t(n.detached ? "access.sessionEndedToastDetached" : "access.sessionEndedToast", { feature, kind: kindLabel }), "warning");
                return;
            }
            // 存取變了（取消分享、帳號被拿掉、帳號停用、隧道不再保留斷線的 shell）：每種 session 說它需要什麼。
            // Access changed: the sentence plus what this kind of session needs.
            if (n.kind === "lost") {
                const { key, need } = lostToast(n.reason, String(msg.kind ?? ""));
                const text = t(key as TranslationKey, { kind: kindLabel });
                showToast(need ? `${text} ${t(need as TranslationKey)}` : text, "warning");
                return;
            }
            showToast(t("sessions.endedToast", { by: n.by, kind: kindLabel }), "warning");
        },
        // 有人開始看你的終端機（停止的那一則不吵你，終端機裡已經有一行）。/ Someone started watching your terminal.
        [NOTIFICATION_ACTIONS.TERMINAL_WATCHED]: (msg) => {
            if (msg.watching !== true) return;
            showToast(t("watch.toast", { by: String(msg.by ?? ""), tunnel: String(msg.tunnel_name ?? "") }), "info");
        },
    });
    return null;
}
