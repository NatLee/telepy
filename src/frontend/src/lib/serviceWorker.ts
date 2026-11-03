/**
 * Telepy 的 service worker（`public/sw.js`）：只負責系統通知，不攔請求、不快取。要安全環境（HTTPS 或 localhost）。
 * Telepy's service worker (`public/sw.js`): system notifications only, no request interception, no caching. Needs a
 * secure context (HTTPS or localhost).
 */

export const SW_URL = "/sw.js";

export function serviceWorkerSupported(): boolean {
    return typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator;
}

/** 註冊（重複註冊沒關係：瀏覽器只在檔案變了才換新的）。/ Register (repeating is harmless: browsers swap only on change). */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
    if (!serviceWorkerSupported()) return null;
    try {
        return await navigator.serviceWorker.register(SW_URL, { scope: "/" });
    } catch {
        return null;
    }
}

/**
 * 經 service worker 顯示系統通知（Android 的 Chrome 只准這樣）；沒有註冊好 = false。`path` = 點下去要去的頁面。
 * Show a system notification through the service worker (the only way Chrome on Android allows); false when none is
 * registered. `path` = where a click should go.
 */
export async function showViaServiceWorker(title: string, options: NotificationOptions & { path?: string }): Promise<boolean> {
    if (!serviceWorkerSupported()) return false;
    try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) return false;
        const { path, ...rest } = options;
        await reg.showNotification(title, { ...rest, data: { path: path ?? null } });
        return true;
    } catch {
        return false;
    }
}
