// Telepy 的 service worker：只負責系統通知——顯示（Android 的 Chrome 只准 service worker 發通知）、點下去回到 Telepy。
// 不攔任何請求、不快取任何東西：每次部署打開的都是新版頁面，不會被舊版卡住。之後的推播（push）也接在這裡。
// Telepy's service worker: system notifications only — showing them (Chrome on Android lets only a service worker do
// that) and bringing Telepy back when one is clicked. It intercepts no requests and caches nothing, so every deploy
// opens the new pages and no old version gets stuck. Push will hook in here later.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const data = event.notification.data || {};
    event.waitUntil(openTelepy(typeof data.path === "string" ? data.path : null));
});

/**
 * 有開著的 Telepy 視窗就把它叫到前面（要去別頁時請頁面自己導覽，終端機不會因為整頁重新載入而斷掉）；沒有才開一個新的。
 * Focus an open Telepy window (asking the page to navigate itself when a path is given, so a terminal is not cut by a
 * full reload); open a new one only when there is none.
 */
async function openTelepy(path) {
    const url = path ? new URL(path, self.location.origin) : null;
    if (url && url.origin !== self.location.origin) return;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = windows.find((w) => w.focused) || windows.find((w) => w.visibilityState === "visible") || windows[0];
    if (target) {
        await target.focus();
        if (url) target.postMessage({ type: "telepy:open", path: url.pathname + url.search + url.hash });
        return;
    }
    await self.clients.openWindow(url ? url.href : "/");
}
