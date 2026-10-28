/**
 * 遠端桌面偏好的本機快取與上傳（lib/desktopDisplay.ts 是純函式那半）。`storeDisplay(…, true)` 也存到帳號；
 * 登入時的帳號 → 本機在 lib/i18n.tsx 的 UserSettingsSync。
 * Local cache and upload for the remote desktop preferences; `storeDisplay(…, true)` also saves them on the account.
 * The sign-in account → local direction is in UserSettingsSync (lib/i18n.tsx).
 */
import { persistUserSetting } from "./userPrefs";
import { DISPLAY_KEY, LEGACY_AUDIO_KEY, LEGACY_QUALITY_KEY, parseDisplayPrefs, serializeDisplayPrefs, toServer, type DisplayPrefs } from "./desktopDisplay";

export const DISPLAY_EVENT = "telepy:desktop-display";

function raw(): [string | null, string | null, string | null] {
    try {
        return [localStorage.getItem(DISPLAY_KEY), localStorage.getItem(LEGACY_QUALITY_KEY), localStorage.getItem(LEGACY_AUDIO_KEY)];
    } catch {
        return [null, null, null];
    }
}

/** 這台瀏覽器有沒有自己的值（新格式或舊的分開存的）。/ Whether this browser has a value of its own. */
export function hasLocalDisplay(): boolean {
    return raw().some((v) => v !== null);
}

// useSyncExternalStore 要同一個物件：依原文快取。/ Cache by the raw strings so the snapshot is stable.
let cache: { key: string; value: DisplayPrefs } | null = null;
export function readDisplay(): DisplayPrefs {
    const [d, q, a] = raw();
    const key = `${d}|${q}|${a}`;
    if (!cache || cache.key !== key) cache = { key, value: parseDisplayPrefs(d, q, a) };
    return cache.value;
}

export function subscribeDisplay(callback: () => void) {
    window.addEventListener(DISPLAY_EVENT, callback);
    window.addEventListener("storage", callback);
    return () => {
        window.removeEventListener(DISPLAY_EVENT, callback);
        window.removeEventListener("storage", callback);
    };
}

/** 存到本機並廣播；`persist` = 也存到帳號。/ Store locally and broadcast; `persist` also saves it on the account. */
export function storeDisplay(p: DisplayPrefs, persist: boolean) {
    try {
        localStorage.setItem(DISPLAY_KEY, serializeDisplayPrefs(p));
        localStorage.removeItem(LEGACY_QUALITY_KEY);
        localStorage.removeItem(LEGACY_AUDIO_KEY);
    } catch {
        /* 私密模式等寫不進去：這次就不記在本機。/ Storage blocked: not cached this time. */
    }
    window.dispatchEvent(new Event(DISPLAY_EVENT));
    if (persist) persistUserSetting({ desktop_display: toServer(p) });
}
