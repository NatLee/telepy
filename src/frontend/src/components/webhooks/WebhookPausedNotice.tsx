"use client";

/**
 * 一個 webhook 連續失敗被暫停：任何頁面都跳提醒（個人的給擁有者，全站的給每個管理員）。
 * A webhook was paused after failing again and again: a heads-up on any page (its owner; every admin for a
 * site-wide one).
 */
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { useNotificationHandlers } from "@/lib/websocket";

export function WebhookPausedNotice() {
    const { t } = useI18n();
    const { showToast } = useToast();
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.WEBHOOK_PAUSED]: (msg) => {
            showToast(t("webhooks.pausedToast", { name: String(msg.name ?? "") }), "warning");
        },
    });
    return null;
}
