/**
 * 桌面通知（瀏覽器 Notification API）：每台瀏覽器自己開（權限也是每台瀏覽器的），開了之後分頁在背景時，
 * 看得到的隧道斷線、恢復或降級會跳系統通知；分頁在前景就不吵（畫面上已經有狀態與提示）。
 * Desktop notifications (browser Notification API), switched on per browser (the permission is per browser too).
 * While the tab is in the background, tunnels you can see going offline, back online or degraded, and commands
 * waiting for your approval, raise a system notification; in the foreground the page itself already shows it.
 */
import { useNotificationHandlers } from "@/lib/websocket";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { NOTIFICATION_ACTIONS, type NotificationPayload } from "@/types/notification";
import { useStoredChoice } from "./useStoredChoice";

const KEY = "telepy.desktopNotify";
const CHOICES = ["on", "off"] as const;

export type DesktopNotifyResult = "granted" | "denied" | "default" | "unsupported";

export function notificationsSupported(): boolean {
    return typeof window !== "undefined" && "Notification" in window;
}

/** 偏好設定的開關：打開時要權限，被拒就維持關閉並回報。/ The preference switch; asks for permission when turned on. */
export function useDesktopNotifyPref(): [boolean, (on: boolean) => Promise<DesktopNotifyResult>] {
    const [choice, setChoice] = useStoredChoice(KEY, CHOICES, "off");
    const set = async (on: boolean): Promise<DesktopNotifyResult> => {
        if (!on) {
            setChoice("off");
            return "default";
        }
        if (!notificationsSupported()) return "unsupported";
        const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
        if (permission === "granted") setChoice("on");
        return permission;
    };
    const on = choice === "on" && notificationsSupported() && Notification.permission === "granted";
    return [on, set];
}

/** 掛在 AppLayout：全站都收得到。/ Mounted in AppLayout so it works on every page. */
export function useDesktopNotifications() {
    const { t } = useI18n();
    const me = useAuth().user?.id;
    const [enabled] = useDesktopNotifyPref();

    const show = (tag: string, body: string) => {
        if (!enabled || document.visibilityState === "visible") return;
        try {
            const n = new Notification("Telepy", { body, tag, icon: "/icon.svg" });
            n.onclick = () => {
                window.focus();
                n.close();
            };
        } catch {
            // 某些環境（例如 Android Chrome）只允許 service worker 發通知：略過。/ Some platforms need a service worker.
        }
    };

    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_STATUS]: (msg: NotificationPayload) => {
            const tunnels = Array.isArray(msg.tunnels) ? (msg.tunnels as { id: number; name: string }[]) : [];
            for (const tn of tunnels) {
                show(`tunnel-${tn.id}`, t(msg.status === "connected" ? "notify.online" : "notify.offline", { name: tn.name }));
            }
        },
        // 有指令等你核准（自己在網頁終端機打的不算）。/ A command waits for your approval (not your own terminal's).
        [NOTIFICATION_ACTIONS.COMMAND_APPROVAL_REQUESTED]: (msg: NotificationPayload) => {
            const req = msg.request as { id: number; user: { id: number; username: string }; source: string; command: string; tunnel_name: string | null } | undefined;
            const approvers = Array.isArray(msg.approver_ids) ? (msg.approver_ids as number[]) : [];
            if (!req || me === undefined || !approvers.includes(me) || (req.user.id === me && req.source === "terminal")) return;
            const command = req.command.length > 80 ? `${req.command.slice(0, 80)}…` : req.command;
            show(`command-${req.id}`, t("notify.commandApproval", { user: req.user.username, command, name: req.tunnel_name ?? "" }));
        },
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_HEALTH]: (msg: NotificationPayload) => {
            if (msg.health === "degraded" && msg.tunnel_id !== undefined && typeof msg.name === "string") {
                show(`tunnel-${msg.tunnel_id}`, t("notify.degraded", { name: msg.name }));
            }
        },
    });
}
