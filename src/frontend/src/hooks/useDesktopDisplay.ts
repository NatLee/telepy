"use client";

/**
 * 遠端桌面的個人偏好（縮放、解析度、HiDPI、畫質、聲音）：存在帳號上，本機快取讓第一個畫面就對（lib/desktopDisplayStore.ts）。
 * 偏好設定的「遠端桌面」分頁、桌面頁的表單與「顯示」選單讀寫同一份。SSR 用預設值。
 * The remote desktop preferences, saved on the account with a local first-paint cache; Preferences, the desktop
 * form and the Display menu share them. SSR renders the defaults.
 */
import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_DISPLAY, type DisplayPrefs } from "@/lib/desktopDisplay";
import { readDisplay, storeDisplay, subscribeDisplay } from "@/lib/desktopDisplayStore";

export function useDesktopDisplay(): [DisplayPrefs, (patch: Partial<DisplayPrefs>) => void] {
    const value = useSyncExternalStore(subscribeDisplay, readDisplay, () => DEFAULT_DISPLAY);
    const update = useCallback((patch: Partial<DisplayPrefs>) => {
        storeDisplay({ ...readDisplay(), ...patch }, true);
    }, []);
    return [value, update];
}
