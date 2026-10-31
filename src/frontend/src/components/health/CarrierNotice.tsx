"use client";

/**
 * 裝置載體換到新版、或自動更新失敗：任何頁面跳提醒（後端只送給管理員，按的人自己除外）。
 * The device carriers were updated, or the automatic update failed: a heads-up on any page (the backend sends it to
 * admins only, never to the one who clicked).
 */
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";

export function CarrierNotice() {
    const { t } = useI18n();
    const { showToast } = useToast();
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.CARRIERS_UPDATED]: (msg) => {
            const targets = Array.isArray(msg.targets) ? msg.targets.length : 0;
            const key = typeof msg.by === "string" && msg.by ? "carriers.toast.updatedBy" : "carriers.toast.updated";
            showToast(t(key, { tag: String(msg.tag ?? ""), count: targets, by: String(msg.by ?? "") }), "success");
        },
        [NOTIFICATION_ACTIONS.CARRIERS_UPDATE_FAILED]: (msg) => {
            showToast(t("carriers.toast.failed", { error: String(msg.error ?? "") }), "warning");
        },
    });
    return null;
}
