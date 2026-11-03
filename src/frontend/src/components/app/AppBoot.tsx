"use client";

/**
 * 每一頁都掛著（根版面）：註冊 service worker（只管系統通知）、接住瀏覽器的安裝提示、點通知時在原本的視窗裡導覽
 * （service worker 傳 `telepy:open` 過來；不整頁重新載入，開著的終端機才不會斷）。不畫任何東西。
 * Mounted on every page (root layout): registers the service worker (system notifications only), keeps the browser's
 * install prompt, and navigates in place when a notification is clicked (the service worker posts `telepy:open`; no
 * full reload, so open terminals survive). Renders nothing.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { catchInstallPrompt } from "@/hooks/useInstallApp";
import { registerServiceWorker, serviceWorkerSupported } from "@/lib/serviceWorker";

export function AppBoot() {
    const router = useRouter();
    useEffect(() => catchInstallPrompt(), []);
    useEffect(() => {
        if (!serviceWorkerSupported()) return;
        void registerServiceWorker();
        const onMessage = (e: MessageEvent) => {
            const data = e.data as { type?: unknown; path?: unknown } | null;
            // 只收同站的路徑（`/` 開頭、不是 `//`）。/ Same-site paths only (a leading `/`, never `//`).
            if (data?.type === "telepy:open" && typeof data.path === "string" && data.path.startsWith("/") && !data.path.startsWith("//")) router.push(data.path);
        };
        navigator.serviceWorker.addEventListener("message", onMessage);
        return () => navigator.serviceWorker.removeEventListener("message", onMessage);
    }, [router]);
    return null;
}
