/**
 * 推播通知的純函式：這台瀏覽器能不能收推播（HTTPS、service worker、PushManager；iPhone / iPad 要先加到主畫面），
 * VAPID 公鑰轉成 `applicationServerKey`，以及說明圖用的推播服務名稱。
 * Pure helpers for push notifications: whether this browser can receive pushes (HTTPS, a service worker, PushManager;
 * iPhone / iPad need Telepy on the Home Screen first), the VAPID key as `applicationServerKey`, and the push service's
 * name for the diagram.
 */

export type PushSupport = "ok" | "insecure" | "iosInstall" | "unsupported";

export interface PushEnv {
    secure: boolean;
    serviceWorker: boolean;
    pushManager: boolean;
    notification: boolean;
    /** iPhone / iPad（iPad 的 Safari 自稱 Mac，看觸控點）。/ iPhone / iPad (iPad Safari says Mac; touch points tell). */
    ios: boolean;
    /** 已經是主畫面上的 app。/ Running as a Home Screen app. */
    standalone: boolean;
}

export function pushSupport(env: PushEnv): PushSupport {
    if (!env.secure) return "insecure";
    // iOS 只有主畫面上的 app 有 PushManager。/ On iOS only Home Screen apps get PushManager.
    if (env.ios && !env.standalone) return "iosInstall";
    if (!env.serviceWorker || !env.pushManager || !env.notification) return "unsupported";
    return "ok";
}

export function isIos(ua: string, touchPoints: number): boolean {
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
}

/** base64url（VAPID 公鑰）→ 位元組。/ base64url (the VAPID key) to bytes. */
export function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64url.length % 4)) % 4);
    const raw = atob(b64);
    const out = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

/** 位元組 → base64url（比對瀏覽器現有訂閱用的是不是同一把公鑰）。/ Bytes to base64url (is an existing subscription on the same key?). */
export function bytesToB64url(bytes: ArrayBuffer | Uint8Array | null): string {
    if (!bytes) return "";
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    for (const b of u) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type PushService = "google" | "apple" | "mozilla" | "microsoft";

export const PUSH_SERVICES: readonly PushService[] = ["google", "apple", "mozilla", "microsoft"];

export function isPushService(v: unknown): v is PushService {
    return typeof v === "string" && (PUSH_SERVICES as readonly string[]).includes(v);
}

/** 一台裝置（`GET /api/push` 的一列）。/ One device (a row of `GET /api/push`). */
export interface PushDevice {
    id: number;
    user_agent: string;
    lang: string;
    details: boolean;
    service: PushService | null;
    current: boolean;
    created_at: string;
    last_success_at: string | null;
    last_error: string | null;
    last_error_at: string | null;
}

export interface PushView {
    enabled: boolean;
    available: boolean;
    public_key: string | null;
    key_error: string | null;
    per_minute: number;
    subscriptions: PushDevice[];
}

/** 這台裝置最近一次送出：沒送過 / 成功 / 失敗（比較新的那個）。/ This device's last delivery: none / ok / failed (whichever is newer). */
export function lastDelivery(d: Pick<PushDevice, "last_success_at" | "last_error_at">): "none" | "ok" | "failed" {
    const ok = d.last_success_at ? Date.parse(d.last_success_at) : NaN;
    const bad = d.last_error_at ? Date.parse(d.last_error_at) : NaN;
    if (Number.isNaN(ok) && Number.isNaN(bad)) return "none";
    if (Number.isNaN(bad)) return "ok";
    if (Number.isNaN(ok)) return "failed";
    return bad > ok ? "failed" : "ok";
}

/**
 * 說明圖：Telepy ─ 加密 ─ 推播服務 ─ 這台裝置 ─ 通知，各段的狀態。沒開 = 全部待命；開了沒送過 = Telepy 好了、其他待命；
 * 最近成功 = 全通；最近失敗 = 斷在推播服務。
 * The diagram: Telepy ─ encrypted ─ push service ─ this device ─ notification. Off = all waiting; on but nothing sent
 * = Telepy ready, the rest waiting; last one delivered = all ok; last one failed = broken at the push service.
 */
export type PushSpot = "waiting" | "ok" | "failed";
export function pushSpots(on: boolean, last: "none" | "ok" | "failed"): { telepy: PushSpot; service: PushSpot; device: PushSpot } {
    if (!on) return { telepy: "waiting", service: "waiting", device: "waiting" };
    if (last === "ok") return { telepy: "ok", service: "ok", device: "ok" };
    if (last === "failed") return { telepy: "ok", service: "failed", device: "waiting" };
    return { telepy: "ok", service: "waiting", device: "waiting" };
}
