"use client";

/**
 * 顯示大小 hook:讀目前的百分比並提供變更函式。以 UI_SCALE_EVENT 為單一事件來源(useSyncExternalStore),
 * sidebar 的切換器、偏好設定 modal、登入後的 UserSettingsSync(applyUiScale)自動保持同步;
 * SSR 一律回預設值避免 hydration 不一致。
 * Display-scale hook — current percent + change function. Subscribes to UI_SCALE_EVENT via
 * useSyncExternalStore so the sidebar switcher, the prefs modal and the post-login UserSettingsSync
 * stay in sync; the server snapshot is always the default to keep hydration stable.
 */
import { useCallback, useSyncExternalStore } from "react";
import { applyUiScale, persistUserSetting, readUiScale, UI_SCALE_DEFAULT, UI_SCALE_EVENT, UI_SCALE_KEY } from "@/lib/userPrefs";

function subscribe(onStoreChange: () => void) {
    window.addEventListener(UI_SCALE_EVENT, onStoreChange);
    // 跨分頁同步:別的分頁改了大小 → 這個分頁也重套。/ Cross-tab: re-apply when another tab changes it.
    const onStorage = (e: StorageEvent) => {
        if (e.key === UI_SCALE_KEY && e.newValue) applyUiScale(parseInt(e.newValue, 10));
    };
    window.addEventListener("storage", onStorage);
    return () => {
        window.removeEventListener(UI_SCALE_EVENT, onStoreChange);
        window.removeEventListener("storage", onStorage);
    };
}

const getServerSnapshot = () => UI_SCALE_DEFAULT;

export function useUiScale(): [number, (next: number) => void] {
    const scale = useSyncExternalStore(subscribe, readUiScale, getServerSnapshot);
    const changeScale = useCallback((next: number) => {
        applyUiScale(next); // 套用到 <html>、寫 localStorage、廣播 / apply, persist, broadcast
        persistUserSetting({ ui_scale: next });
    }, []);
    return [scale, changeScale];
}
