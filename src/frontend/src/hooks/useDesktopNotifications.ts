/**
 * 桌面通知（瀏覽器 Notification API）：每台瀏覽器自己開（權限也是每台瀏覽器的），開了之後分頁在背景時，
 * 看得到的隧道斷線、恢復或降級、等你核准的指令，以及其他有網頁內提示的事件會跳系統通知；分頁在前景就不吵（畫面上已經有）。
 * 每個事件還要過通知偏好（`useNotifyPrefs`：全站預設 → 我的 → 這條隧道的靜音；管理員強制的一定過）。
 * Desktop notifications (browser Notification API), switched on per browser (the permission is per browser too).
 * While the tab is in the background, tunnels you can see going offline, back online or degraded, and commands
 * waiting for your approval, and the other events with an in-app notification raise a system notification; in the
 * foreground the page itself already shows it. Each event also has to pass the notification preferences
 * (`useNotifyPrefs`: site default → mine → tunnel mute; enforced ones always pass).
 */
import { useNotificationHandlers } from "@/lib/websocket";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { NOTIFICATION_ACTIONS, type NotificationPayload } from "@/types/notification";
import { WARNING_KINDS } from "@/lib/deviceFacts";
import { placeLabel, type IpGeo } from "@/lib/geo";
import type { DeviceWarningKind } from "@/types/tunnel";
import { useStoredChoice } from "./useStoredChoice";
import { allowNotification, useNotifyPrefsLoader } from "./useNotifyPrefs";

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
    const { t, locale } = useI18n();
    const auth = useAuth();
    const me = auth.user?.id;
    const [enabled] = useDesktopNotifyPref();
    // 通知偏好在這裡（AppLayout）載入一次。/ Notification preferences load here (AppLayout), once per sign-in.
    useNotifyPrefsLoader(me !== undefined);

    // 每個事件 × 這條隧道的偏好也要讓它過。/ The per-event (and per-tunnel) preference must allow it too.
    const show = (tag: string, body: string, msg?: NotificationPayload, tunnelId?: number) => {
        if (!enabled || document.visibilityState === "visible") return;
        if (msg && !allowNotification(msg, "desktop", tunnelId)) return;
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
                show(`tunnel-${tn.id}`, t(msg.status === "connected" ? "notify.online" : "notify.offline", { name: tn.name }), msg, tn.id);
            }
        },
        // 有指令等你核准（自己在網頁終端機打的不算）。/ A command waits for your approval (not your own terminal's).
        [NOTIFICATION_ACTIONS.COMMAND_APPROVAL_REQUESTED]: (msg: NotificationPayload) => {
            const req = msg.request as { id: number; user: { id: number; username: string }; source: string; command: string; tunnel_name: string | null } | undefined;
            const approvers = Array.isArray(msg.approver_ids) ? (msg.approver_ids as number[]) : [];
            if (!req || me === undefined || !approvers.includes(me) || (req.user.id === me && req.source === "terminal")) return;
            const command = req.command.length > 80 ? `${req.command.slice(0, 80)}…` : req.command;
            show(`command-${req.id}`, t("notify.commandApproval", { user: req.user.username, command, name: req.tunnel_name ?? "" }), msg);
        },
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_HEALTH]: (msg: NotificationPayload) => {
            if (msg.health === "degraded" && msg.tunnel_id !== undefined && typeof msg.name === "string") {
                show(`tunnel-${msg.tunnel_id}`, t("notify.degraded", { name: msg.name }), msg);
            }
        },
        // 其餘也有網頁內提示的事件：分頁在背景時一樣跳桌面通知（每一種都能在偏好設定裡關掉）。
        // The other events with an in-app notification: a desktop notification too while the tab is hidden (each
        // can be turned off in Preferences).
        [NOTIFICATION_ACTIONS.TUNNEL_IP_CHANGED]: (msg: NotificationPayload) => {
            if (typeof msg.ip !== "string") return;
            show(`ip-${msg.tunnel_id}`, t("tunnels.ipChangedToast", { name: String(msg.tunnel_name ?? ""), ip: msg.ip, previous: String(msg.previous_ip ?? "") }), msg);
        },
        [NOTIFICATION_ACTIONS.HOST_KEY_CHANGED]: (msg: NotificationPayload) => {
            // 通知裡沒有隧道名稱，用後端的那句。/ No tunnel name in the payload: use the backend's sentence.
            show(`hostkey-${msg.tunnel_id}`, typeof msg.details === "string" ? msg.details : t("hostKey.notify", { name: `#${msg.tunnel_id ?? "?"}` }), msg);
        },
        [NOTIFICATION_ACTIONS.DEVICE_CLAIM_ATTEMPT]: (msg: NotificationPayload) => {
            show(`claim-${msg.tunnel_id}`, t("hostKey.claimNotify", { name: String(msg.tunnel_name ?? `#${msg.tunnel_id ?? "?"}`), by: String(msg.by ?? "?") }), msg);
        },
        [NOTIFICATION_ACTIONS.DEVICE_WARNING]: (msg: NotificationPayload) => {
            const kinds = Array.isArray(msg.warnings) ? (msg.warnings as string[]).filter((k) => (WARNING_KINDS as string[]).includes(k)) : [];
            if (kinds.length === 0) return;
            const what = kinds.map((k) => t(`deviceFacts.chip.${k as DeviceWarningKind}`)).join(", ");
            show(`warning-${msg.tunnel_id}`, t("tunnels.deviceWarningToast", { name: String(msg.tunnel_name ?? ""), what }), msg);
        },
        [NOTIFICATION_ACTIONS.TUNNEL_SHARED]: (msg: NotificationPayload) => {
            if (msg.details) show(`share-${msg.tunnel_id}`, String(msg.details), msg);
        },
        [NOTIFICATION_ACTIONS.TUNNEL_UNSHARED]: (msg: NotificationPayload) => {
            if (msg.details) show(`share-${msg.tunnel_id}`, String(msg.details), msg);
        },
        [NOTIFICATION_ACTIONS.ACCESS_REQUEST_CREATED]: (msg: NotificationPayload) => {
            if (msg.details) show(`access-${msg.tunnel_id}`, String(msg.details), msg);
        },
        [NOTIFICATION_ACTIONS.ACCESS_REQUEST_DECIDED]: (msg: NotificationPayload) => {
            if (msg.details) show(`access-${msg.tunnel_id}`, String(msg.details), msg);
        },
        [NOTIFICATION_ACTIONS.AI_SESSION_OPENED]: (msg: NotificationPayload) => {
            if (msg.details && msg.by && msg.by !== auth.user?.username) show(`ai-${msg.tunnel_id}`, String(msg.details), msg);
        },
        [NOTIFICATION_ACTIONS.AI_SESSION_CLOSED]: (msg: NotificationPayload) => {
            if (msg.details && msg.by && msg.by !== auth.user?.username) show(`ai-${msg.tunnel_id}`, String(msg.details), msg);
        },
        [NOTIFICATION_ACTIONS.TERMINAL_WATCHED]: (msg: NotificationPayload) => {
            if (msg.watching !== true) return;
            show(`watch-${msg.shell_id}`, t("watch.toast", { by: String(msg.by ?? ""), tunnel: String(msg.tunnel_name ?? "") }), msg);
        },
        [NOTIFICATION_ACTIONS.SIGN_IN_NEW_DEVICE]: (msg: NotificationPayload) => {
            const geo = (msg.geo ?? null) as IpGeo | null;
            const ip = typeof msg.ip === "string" ? msg.ip : "";
            const place = [ip, placeLabel(geo, locale)].filter(Boolean).join(", ") || "?";
            const device = typeof msg.device === "string" && msg.device ? msg.device : t("security.unknownDevice");
            show("sign-in", t("security.newDeviceToast", { device, place }), msg);
        },
    });
}
