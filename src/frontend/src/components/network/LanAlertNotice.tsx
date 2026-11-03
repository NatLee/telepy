"use client";

/**
 * 區網提醒：網段上有新機器（owner / Admin）、你注意的主機不見了 / 回來了 / port 變了——任何頁面跳一個提示（照通知偏好）。
 * LAN alerts on any page: new machines on the network (owner / Admins), a host you watch down / back / ports changed
 * (following the notification preferences).
 */
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { useNotificationHandlers } from "@/lib/websocket";
import { allowNotification } from "@/hooks/useNotifyPrefs";
import { lanNewHostsText, lanWatchText } from "@/lib/lanAlerts";

export function LanAlertNotice() {
    const { t } = useI18n();
    const { showToast } = useToast();
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.LAN_NEW_HOSTS]: (msg) => {
            if (allowNotification(msg, "toast")) showToast(lanNewHostsText(t, msg), "info");
        },
        [NOTIFICATION_ACTIONS.LAN_HOST_WATCH]: (msg) => {
            if (allowNotification(msg, "toast")) showToast(lanWatchText(t, msg), msg.state === "up" ? "success" : "warning");
        },
    });
    return null;
}
