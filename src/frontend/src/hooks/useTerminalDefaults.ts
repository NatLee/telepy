"use client";

/**
 * 終端機外觀的個人預設(字型 / 字級 / 配色)hook。以 TERMINAL_APPEARANCE_EVENT 為單一事件來源
 * (useSyncExternalStore),所以偏好設定 modal、終端機頁的外觀對話框、開著的終端機與登入後的
 * UserSettingsSync 自動保持一致;別的分頁改了(storage 事件)這裡也跟著變。SSR 一律回預設值。
 * 寫回後端合併成一次、延遲 400 ms,拖滑桿不會每一格送一個請求。
 * Personal terminal defaults hook (font / size / colour scheme). TERMINAL_APPEARANCE_EVENT is the single
 * source (useSyncExternalStore), so the preferences modal, the terminal's appearance dialog, open
 * terminals and the post-login UserSettingsSync agree; other tabs' changes arrive via storage events. The
 * server snapshot is the default. Backend writes are merged and delayed 400 ms so a slider drag is one request.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { TerminalDefaults } from "@/lib/terminalAppearance";
import {
    applyTerminalDefaults,
    persistUserSetting,
    readTerminalDefaults,
    TERMINAL_APPEARANCE_EVENT,
    TERMINAL_DEFAULTS_FALLBACK,
    TERMINAL_FONT_KEY,
    TERMINAL_FONT_SIZE_KEY,
    TERMINAL_SCHEME_KEY,
    terminalDefaultsToSettings,
} from "@/lib/userPrefs";

const KEYS = [TERMINAL_FONT_KEY, TERMINAL_FONT_SIZE_KEY, TERMINAL_SCHEME_KEY];

function subscribe(onStoreChange: () => void) {
    window.addEventListener(TERMINAL_APPEARANCE_EVENT, onStoreChange);
    const onStorage = (e: StorageEvent) => {
        if (e.key && KEYS.includes(e.key)) onStoreChange();
    };
    window.addEventListener("storage", onStorage);
    return () => {
        window.removeEventListener(TERMINAL_APPEARANCE_EVENT, onStoreChange);
        window.removeEventListener("storage", onStorage);
    };
}

// useSyncExternalStore 要求同一份資料回傳同一個物件,否則會無限重繪。/ Same data → same object, or React loops.
let cached: { key: string; value: TerminalDefaults } | null = null;
function getSnapshot(): TerminalDefaults {
    const value = readTerminalDefaults();
    const key = `${value.font}|${value.fontSize}|${value.scheme}`;
    if (cached?.key !== key) cached = { key, value };
    return cached.value;
}
const getServerSnapshot = () => TERMINAL_DEFAULTS_FALLBACK;

let pending: Partial<TerminalDefaults> = {};
let timer: ReturnType<typeof setTimeout> | null = null;
function persistLater(patch: Partial<TerminalDefaults>) {
    pending = { ...pending, ...patch };
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
        const body = terminalDefaultsToSettings(pending);
        pending = {};
        timer = null;
        persistUserSetting(body);
    }, 400);
}

export function useTerminalDefaults(): [TerminalDefaults, (patch: Partial<TerminalDefaults>) => void] {
    const defaults = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
    const change = useCallback((patch: Partial<TerminalDefaults>) => {
        applyTerminalDefaults(patch); // 寫 localStorage + 廣播 / persist locally + broadcast
        persistLater(patch);
    }, []);
    return [defaults, change];
}
