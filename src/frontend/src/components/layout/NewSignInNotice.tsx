"use client";

/**
 * 你的帳號從 90 天內沒見過的國家或瀏覽器登入（`SIGN-IN-NEW-DEVICE`）：任何頁面跳一個提醒，指到「你的裝置」。
 * A sign-in to your account from a country or browser not seen in 90 days: a heads-up on any page.
 */
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { useNotificationHandlers } from "@/lib/websocket";
import { allowNotification } from "@/hooks/useNotifyPrefs";
import { placeLabel, type IpGeo } from "@/lib/geo";

export function NewSignInNotice() {
    const { t, locale } = useI18n();
    const { showToast } = useToast();
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.SIGN_IN_NEW_DEVICE]: (msg) => {
            if (!allowNotification(msg, "toast")) return;
            const geo = (msg.geo ?? null) as IpGeo | null;
            const ip = typeof msg.ip === "string" ? msg.ip : "";
            const place = [ip, placeLabel(geo, locale)].filter(Boolean).join(", ") || "?";
            const device = typeof msg.device === "string" && msg.device ? msg.device : t("security.unknownDevice");
            showToast(t("security.newDeviceToast", { device, place }), "warning");
        },
    });
    return null;
}
