/**
 * 推播通知（這台裝置）：伺服器的狀態（`GET /api/push`）與瀏覽器的訂閱放在一個模組 store，偏好設定的面板與全站的桌面通知
 * 共用——開著推播的裝置，網頁自己就不再跳同一則桌面通知（推播會到）。開啟要在點擊裡做（iOS 只在使用者動作裡給權限）。
 * Push notifications on this device: the server's state (`GET /api/push`) and the browser's subscription in one module
 * store, shared by the Preferences panel and the site-wide desktop notifications — a device with push on no longer gets
 * the page's own copy (the push arrives). Turning it on must happen in a click (iOS grants permission only then).
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { bytesToB64url, isIos, keyBytes, pushSupport, type PushSupport, type PushView } from "@/lib/push";
import { serviceWorkerSupported } from "@/lib/serviceWorker";
import { isStandalone } from "./useInstallApp";

interface Store {
    view: PushView | null;
    /** 瀏覽器手上有訂閱。/ The browser holds a subscription. */
    browserSub: boolean;
    loading: boolean;
}

let store: Store = { view: null, browserSub: false, loading: false };
let loaded = false;
const listeners = new Set<() => void>();
const set = (patch: Partial<Store>) => {
    store = { ...store, ...patch };
    listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
};

export function currentPushSupport(): PushSupport {
    if (typeof window === "undefined") return "unsupported";
    return pushSupport({
        secure: window.isSecureContext,
        serviceWorker: "serviceWorker" in navigator,
        pushManager: "PushManager" in window,
        notification: "Notification" in window,
        ios: isIos(navigator.userAgent, navigator.maxTouchPoints ?? 0),
        standalone: isStandalone(),
    });
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
    if (!serviceWorkerSupported()) return null;
    try {
        return (await navigator.serviceWorker.getRegistration()) ?? null;
    } catch {
        return null;
    }
}

async function browserSubscription(): Promise<PushSubscription | null> {
    const reg = await registration();
    try {
        return (await reg?.pushManager?.getSubscription()) ?? null;
    } catch {
        return null;
    }
}

/** 重新讀伺服器與瀏覽器的狀態。/ Re-read the server's and the browser's state. */
export async function loadPush(): Promise<void> {
    loaded = true;
    set({ loading: true });
    try {
        const res = await apiFetch("/api/push");
        const view = res.ok ? await readJson<PushView>(res) : null;
        const sub = currentPushSupport() === "ok" ? await browserSubscription() : null;
        set({ view, browserSub: !!sub });
    } catch {
        /* 讀不到就維持原狀 / keep what we had */
    } finally {
        set({ loading: false });
    }
}

/** 這台裝置正在收推播（伺服器記著這次登入的訂閱，瀏覽器也還有）。/ This device is receiving pushes. */
export function pushActiveHere(): boolean {
    return !!store.view?.available && store.browserSub && !!store.view.subscriptions.some((s) => s.current);
}

/** 登出時：瀏覽器那邊的訂閱也取消（伺服器那筆已經跟著登入刪了）。/ On sign-out: drop the browser's subscription too. */
export async function dropPushHere(): Promise<void> {
    const sub = await browserSubscription();
    try {
        await sub?.unsubscribe();
    } catch {
        /* 取消不了也沒關係，伺服器已經不送 / harmless: the server no longer sends */
    }
    store = { view: null, browserSub: false, loading: false };
    loaded = false;
    listeners.forEach((l) => l());
}

async function send(path: string, method: string, body?: unknown): Promise<PushView & { outcome?: string; error?: string | null }> {
    const res = await apiFetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await readJson<PushView & { outcome?: string; error?: string | null; code?: string }>(res);
    if (!res.ok || !json) {
        const e = new Error(responseError(res, json, `HTTP ${res.status}`)) as Error & { code?: string };
        e.code = json?.code;
        throw e;
    }
    set({ view: json });
    return json;
}

export function usePush() {
    const s = useSyncExternalStore(subscribe, () => store, () => store);
    useEffect(() => {
        if (!loaded) void loadPush();
    }, []);
    const current = s.view?.subscriptions.find((d) => d.current) ?? null;

    /** 打開：權限 → 訂閱（同一把公鑰就沿用）→ 交給伺服器。/ Turn on: permission → subscribe (reusing one on the same key) → register. */
    const enable = useCallback(async (opts: { lang: string; details: boolean }): Promise<"on" | "denied"> => {
        const view = store.view;
        if (!view?.public_key) throw new Error("push is not available");
        const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
        if (permission !== "granted") return "denied";
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        // 舊訂閱是別把公鑰的（伺服器換過金鑰）：先取消再訂。/ An old subscription on another key: unsubscribe first.
        if (sub && bytesToB64url(sub.options.applicationServerKey) !== view.public_key) {
            await sub.unsubscribe();
            sub = null;
        }
        try {
            sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(view.public_key) });
        } catch (e) {
            // 權限被擋（含無痕視窗：Chrome 在那裡一律拒絕推播）= 跟拒絕通知一樣說明。/ Blocked (incl. incognito, where Chrome refuses push) reads like a denied permission.
            if (e instanceof DOMException && e.name === "NotAllowedError") return "denied";
            throw e;
        }
        const json = sub.toJSON();
        await send("/api/push/subscriptions", "POST", { endpoint: json.endpoint, keys: json.keys, lang: opts.lang, details: opts.details });
        set({ browserSub: true });
        return "on";
    }, []);

    const disable = useCallback(async () => {
        const id = store.view?.subscriptions.find((d) => d.current)?.id;
        if (id !== undefined) await send(`/api/push/subscriptions/${id}`, "DELETE");
        const sub = await browserSubscription();
        try {
            await sub?.unsubscribe();
        } catch {
            /* 伺服器已經不送 / the server no longer sends */
        }
        set({ browserSub: false });
    }, []);

    const update = useCallback((id: number, patch: { details?: boolean; lang?: string }) => send(`/api/push/subscriptions/${id}`, "PATCH", patch), []);
    const remove = useCallback((id: number) => send(`/api/push/subscriptions/${id}`, "DELETE"), []);
    const test = useCallback((id: number) => send(`/api/push/subscriptions/${id}/test`, "POST", {}), []);

    return { view: s.view, loading: s.loading, support: currentPushSupport(), on: pushActiveHere(), current, enable, disable, update, remove, test, refresh: loadPush };
}

/**
 * 全站掛著（桌面通知那裡）：每次登入讀一次狀態（給「這台開著推播就不重複跳」用），介面語言換了就讓伺服器跟著換。
 * Mounted site-wide (with the desktop notifications): reads the state once per sign-in (for "no duplicate when push is
 * on here") and keeps the server's copy of this device's language in step with the interface.
 */
export function usePushSync(signedIn: boolean, locale: string) {
    const s = useSyncExternalStore(subscribe, () => store, () => store);
    useEffect(() => {
        if (signedIn && !loaded) void loadPush();
    }, [signedIn]);
    const current = s.view?.subscriptions.find((d) => d.current);
    useEffect(() => {
        if (current && s.browserSub && current.lang !== locale) void send(`/api/push/subscriptions/${current.id}`, "PATCH", { lang: locale }).catch(() => undefined);
    }, [current, s.browserSub, locale]);
}
