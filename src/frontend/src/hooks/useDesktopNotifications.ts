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
import { useAppName } from "./useAppName";
import { pushActiveHere, usePushSync } from "./usePush";
import { showViaServiceWorker } from "@/lib/serviceWorker";

const KEY = "telepy.desktopNotify";
const CHOICES = ["on", "off"] as const;
/** 這台裝置的通知要不要寫出指令內容（鎖定畫面別人看得到，預設不寫）。/ Whether this device's notifications show the command (off by default: others can see a lock screen). */
const DETAILS_KEY = "telepy.notifyDetails";
const DETAILS = ["hide", "show"] as const;

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

/**
 * 這台裝置的系統通知要不要寫出指令內容（等你核准的指令）。每台裝置各自設：手機的鎖定畫面別人看得到，筆電不一定。
 * 關（預設）= 只說誰、在哪條通道要執行指令，打開 Telepy 才看得到內容。
 * Whether this device's system notifications show the command awaiting approval. Per device: a phone's lock screen is
 * visible to others, a laptop's maybe not. Off (the default) = only who asks and on which tunnel; open Telepy to see it.
 */
export function useNotifyDetailsPref(): [boolean, (on: boolean) => void] {
    const [choice, setChoice] = useStoredChoice(DETAILS_KEY, DETAILS, "hide");
    return [choice === "show", (on: boolean) => setChoice(on ? "show" : "hide")];
}

/** 掛在 AppLayout：全站都收得到。/ Mounted in AppLayout so it works on every page. */
export function useDesktopNotifications() {
    const { t, locale } = useI18n();
    const auth = useAuth();
    const me = auth.user?.id;
    const [enabled] = useDesktopNotifyPref();
    const [details] = useNotifyDetailsPref();
    // 標題 = 網站設定的 App 名稱，裝了兩台 Telepy 時分得出來。/ The title = the site's app name, so two Telepy servers differ.
    const title = useAppName();
    // 推播：這台裝置開著推播時，伺服器推過來的那幾種事件網頁就不再自己跳一次。/ Push: with push on here, the pushed events aren't shown twice.
    usePushSync(me !== undefined, locale);
    // 通知偏好在這裡（AppLayout）載入一次。/ Notification preferences load here (AppLayout), once per sign-in.
    useNotifyPrefsLoader(me !== undefined);

    // 每個事件 × 這條隧道的偏好也要讓它過。/ The per-event (and per-tunnel) preference must allow it too.
    const show = (tag: string, body: string, msg?: NotificationPayload, tunnelId?: number) => {
        if (!enabled || document.visibilityState === "visible") return;
        if (msg && !allowNotification(msg, "desktop", tunnelId)) return;
        try {
            const n = new Notification(title, { body, tag, icon: "/icon.svg" });
            n.onclick = () => {
                window.focus();
                n.close();
            };
        } catch {
            // Android 的 Chrome 只准 service worker 發通知（建構子會丟錯）：改走 `public/sw.js`。
            // Chrome on Android only lets a service worker show notifications (the constructor throws): use `public/sw.js`.
            void showViaServiceWorker(title, { body, tag, icon: "/icons/icon-192.png" });
        }
    };

    // 伺服器也會推播的事件（上線 / 離線 / 降級照這個人選的延遲）：這台開著推播就交給推播。/ Events the server pushes too (status after the person's own wait): left to the push when it is on here.
    const showPushed = (tag: string, body: string, msg?: NotificationPayload, tunnelId?: number) => {
        if (pushActiveHere()) return;
        show(tag, body, msg, tunnelId);
    };

    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_STATUS]: (msg: NotificationPayload) => {
            const tunnels = Array.isArray(msg.tunnels) ? (msg.tunnels as { id: number; name: string }[]) : [];
            for (const tn of tunnels) {
                showPushed(`tunnel-${tn.id}`, t(msg.status === "connected" ? "notify.online" : "notify.offline", { name: tn.name }), msg, tn.id);
            }
        },
        // 有指令等你核准（自己在網頁終端機打的不算）。/ A command waits for your approval (not your own terminal's).
        [NOTIFICATION_ACTIONS.COMMAND_APPROVAL_REQUESTED]: (msg: NotificationPayload) => {
            const req = msg.request as { id: number; user: { id: number; username: string }; source: string; command: string; tunnel_name: string | null } | undefined;
            const approvers = Array.isArray(msg.approver_ids) ? (msg.approver_ids as number[]) : [];
            if (!req || me === undefined || !approvers.includes(me) || (req.user.id === me && req.source === "terminal")) return;
            const command = req.command.length > 80 ? `${req.command.slice(0, 80)}…` : req.command;
            const vars = { user: req.user.username, command, name: req.tunnel_name ?? "" };
            showPushed(`command-${req.id}`, details ? t("notify.commandApproval", vars) : t("notify.commandApprovalHidden", vars), msg);
        },
        [NOTIFICATION_ACTIONS.UPDATE_TUNNEL_HEALTH]: (msg: NotificationPayload) => {
            if (msg.health === "degraded" && msg.tunnel_id !== undefined && typeof msg.name === "string") {
                showPushed(`tunnel-${msg.tunnel_id}`, t("notify.degraded", { name: msg.name }), msg);
            }
        },
        // 其餘也有網頁內提示的事件：分頁在背景時一樣跳桌面通知（每一種都能在偏好設定裡關掉）。
        // The other events with an in-app notification: a desktop notification too while the tab is hidden (each
        // can be turned off in Preferences).
        [NOTIFICATION_ACTIONS.TUNNEL_IP_CHANGED]: (msg: NotificationPayload) => {
            if (typeof msg.ip !== "string") return;
            showPushed(`ip-${msg.tunnel_id}`, t("tunnels.ipChangedToast", { name: String(msg.tunnel_name ?? ""), ip: msg.ip, previous: String(msg.previous_ip ?? "") }), msg);
        },
        [NOTIFICATION_ACTIONS.HOST_KEY_CHANGED]: (msg: NotificationPayload) => {
            // 通知裡沒有隧道名稱，用後端的那句。/ No tunnel name in the payload: use the backend's sentence.
            showPushed(`hostkey-${msg.tunnel_id}`, typeof msg.details === "string" ? msg.details : t("hostKey.notify", { name: `#${msg.tunnel_id ?? "?"}` }), msg);
        },
        [NOTIFICATION_ACTIONS.DEVICE_CLAIM_ATTEMPT]: (msg: NotificationPayload) => {
            showPushed(`claim-${msg.tunnel_id}`, t("hostKey.claimNotify", { name: String(msg.tunnel_name ?? `#${msg.tunnel_id ?? "?"}`), by: String(msg.by ?? "?") }), msg);
        },
        [NOTIFICATION_ACTIONS.DEVICE_WARNING]: (msg: NotificationPayload) => {
            const kinds = Array.isArray(msg.warnings) ? (msg.warnings as string[]).filter((k) => (WARNING_KINDS as string[]).includes(k)) : [];
            if (kinds.length === 0) return;
            const what = kinds.map((k) => t(`deviceFacts.chip.${k as DeviceWarningKind}`)).join(", ");
            showPushed(`warning-${msg.tunnel_id}`, t("tunnels.deviceWarningToast", { name: String(msg.tunnel_name ?? ""), what }), msg);
        },
        [NOTIFICATION_ACTIONS.TUNNEL_SHARED]: (msg: NotificationPayload) => {
            if (msg.details) showPushed(`share-${msg.tunnel_id}`, String(msg.details), msg);
        },
        [NOTIFICATION_ACTIONS.TUNNEL_UNSHARED]: (msg: NotificationPayload) => {
            if (msg.details) showPushed(`share-${msg.tunnel_id}`, String(msg.details), msg);
        },
        [NOTIFICATION_ACTIONS.ACCESS_REQUEST_CREATED]: (msg: NotificationPayload) => {
            if (msg.details) showPushed(`access-${msg.tunnel_id}`, String(msg.details), msg);
        },
        [NOTIFICATION_ACTIONS.ACCESS_REQUEST_DECIDED]: (msg: NotificationPayload) => {
            if (msg.details) showPushed(`access-${msg.tunnel_id}`, String(msg.details), msg);
        },
        [NOTIFICATION_ACTIONS.AI_SESSION_OPENED]: (msg: NotificationPayload) => {
            if (msg.details && msg.by && msg.by !== auth.user?.username) showPushed(`ai-${msg.tunnel_id}`, String(msg.details), msg);
        },
        [NOTIFICATION_ACTIONS.AI_SESSION_CLOSED]: (msg: NotificationPayload) => {
            if (msg.details && msg.by && msg.by !== auth.user?.username) showPushed(`ai-${msg.tunnel_id}`, String(msg.details), msg);
        },
        [NOTIFICATION_ACTIONS.TERMINAL_WATCHED]: (msg: NotificationPayload) => {
            if (msg.watching !== true) return;
            showPushed(`watch-${msg.tunnel_id}`, t("watch.toast", { by: String(msg.by ?? ""), tunnel: String(msg.tunnel_name ?? "") }), msg);
        },
        [NOTIFICATION_ACTIONS.SIGN_IN_NEW_DEVICE]: (msg: NotificationPayload) => {
            const geo = (msg.geo ?? null) as IpGeo | null;
            const ip = typeof msg.ip === "string" ? msg.ip : "";
            const place = [ip, placeLabel(geo, locale)].filter(Boolean).join(", ") || "?";
            const device = typeof msg.device === "string" && msg.device ? msg.device : t("security.unknownDevice");
            showPushed("sign-in", t("security.newDeviceToast", { device, place }), msg);
        },
    });
}
