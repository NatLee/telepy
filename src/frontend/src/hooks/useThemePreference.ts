"use client";

/**
 * 主題偏好 hook:讀取目前主題並提供切換函式。
 * 以 THEME_EVENT 為單一事件來源(useSyncExternalStore),sidebar 切換器、偏好設定 modal、
 * 登入後的 UserSettingsSync(applyTheme)之間自動保持同步;SSR 一律回 "system" 避免 hydration 不一致。
 * Theme preference hook — current theme + change function. Subscribes to THEME_EVENT via
 * useSyncExternalStore so the sidebar switcher, the prefs modal, and the post-login
 * UserSettingsSync stay in sync; the server snapshot is always "system" to keep hydration stable.
 */
import { useCallback, useSyncExternalStore } from "react";
import {
    applyTheme,
    isTheme,
    persistUserSetting,
    readStoredTheme,
    THEME_EVENT,
    THEME_STORAGE_KEY,
    type Theme,
} from "@/lib/userPrefs";

function subscribe(onStoreChange: () => void) {
    window.addEventListener(THEME_EVENT, onStoreChange);
    // 跨分頁同步:別的分頁改了主題(storage 事件)→ 在這個分頁重套 dark class,
    // applyTheme 會再廣播 THEME_EVENT 讓所有訂閱者更新。
    // Cross-tab sync: another tab changed the theme → re-apply the class here;
    // applyTheme re-broadcasts THEME_EVENT so every subscriber updates.
    const onStorage = (e: StorageEvent) => {
        if (e.key === THEME_STORAGE_KEY && isTheme(e.newValue)) applyTheme(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => {
        window.removeEventListener(THEME_EVENT, onStoreChange);
        window.removeEventListener("storage", onStorage);
    };
}

const getServerSnapshot = (): Theme => "system";

export function useThemePreference(): [Theme, (next: Theme) => void] {
    const theme = useSyncExternalStore(subscribe, readStoredTheme, getServerSnapshot);
    const changeTheme = useCallback((next: Theme) => {
        applyTheme(next); // 寫 localStorage、切 dark class、廣播 THEME_EVENT / persists, toggles class, broadcasts
        persistUserSetting({ theme: next });
    }, []);
    return [theme, changeTheme];
}
