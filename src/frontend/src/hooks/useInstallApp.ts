/**
 * 「安裝成 app」：接住 Chrome / Edge 的 `beforeinstallprompt`（`AppBoot` 一開站就接，晚了就沒了），現在是不是已經在自己的
 * 視窗裡，以及這台瀏覽器該怎麼裝（`lib/installApp.installGuide`）。
 * "Install as an app": keeps Chrome / Edge's `beforeinstallprompt` (caught by `AppBoot` at start, it fires only once),
 * whether this already runs in its own window, and how this browser installs it (`lib/installApp.installGuide`).
 */
import { useCallback, useSyncExternalStore } from "react";
import { installGuide, type InstallGuide } from "@/lib/installApp";

interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
};

/**
 * 開站時呼叫一次：留住安裝提示（也就不會在登入頁跳出 Chrome 自己的安裝列）、裝好後清掉。回傳取消函式。
 * Call once at start: keeps the install prompt (so Chrome's own install bar never pops up on the sign-in page) and
 * clears it once installed. Returns the cleanup.
 */
export function catchInstallPrompt(): () => void {
    const onPrompt = (e: Event) => {
        e.preventDefault();
        deferred = e as BeforeInstallPromptEvent;
        emit();
    };
    const onInstalled = () => {
        deferred = null;
        emit();
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
        window.removeEventListener("beforeinstallprompt", onPrompt);
        window.removeEventListener("appinstalled", onInstalled);
    };
}

const STANDALONE = "(display-mode: standalone), (display-mode: window-controls-overlay), (display-mode: fullscreen)";

/** 現在是不是在自己的視窗裡（裝好的 app）。/ Whether this runs in its own window (an installed app). */
export function isStandalone(): boolean {
    if (typeof window === "undefined") return false;
    return window.matchMedia(STANDALONE).matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function subscribeStandalone(l: () => void) {
    const mq = window.matchMedia(STANDALONE);
    mq.addEventListener("change", l);
    const off = subscribe(l);
    return () => {
        mq.removeEventListener("change", l);
        off();
    };
}

export function useInstallApp(): { guide: InstallGuide; standalone: boolean; install: () => Promise<"accepted" | "dismissed" | null> } {
    const canPrompt = useSyncExternalStore(subscribe, () => deferred !== null, () => false);
    const standalone = useSyncExternalStore(subscribeStandalone, isStandalone, () => false);
    const guide = typeof window === "undefined"
        ? "other"
        : installGuide({ ua: navigator.userAgent, standalone, secure: window.isSecureContext, canPrompt, touchPoints: navigator.maxTouchPoints ?? 0 });
    const install = useCallback(async () => {
        const e = deferred;
        if (!e) return null;
        await e.prompt();
        const { outcome } = await e.userChoice;
        // 一個提示只能用一次。/ A prompt works once.
        deferred = null;
        emit();
        return outcome;
    }, []);
    return { guide, standalone, install };
}
