/**
 * 「卡片 / 清單」偏好的本機快取與上傳（lib/viewModes.ts 是純函式那半）。`storeViewModes(…, true)` 也存到帳號；
 * 登入時的伺服器 → 本機在 lib/i18n.tsx 的 UserSettingsSync。
 * Local cache and upload for the card / list preference (lib/viewModes.ts holds the pure half).
 * `storeViewModes(…, true)` also saves it on the account; the sign-in server → local direction is in
 * UserSettingsSync (lib/i18n.tsx).
 */
import { persistUserSetting } from "./userPrefs";
import { LEGACY_TUNNELS_VIEW_KEY, localViewModes, VIEW_MODES_EVENT, VIEW_MODES_KEY, type ViewModes } from "./viewModes";

export function readViewModes(): ViewModes {
    try {
        return localViewModes(localStorage.getItem(VIEW_MODES_KEY), localStorage.getItem(LEGACY_TUNNELS_VIEW_KEY));
    } catch {
        return {};
    }
}

/** useSyncExternalStore 的快照：原始字串（穩定的原始值）。/ Snapshot for useSyncExternalStore: the raw strings. */
export function viewModesSnapshot(): string {
    try {
        return `${localStorage.getItem(VIEW_MODES_KEY) ?? ""}|${localStorage.getItem(LEGACY_TUNNELS_VIEW_KEY) ?? ""}`;
    } catch {
        return "";
    }
}

export function subscribeViewModes(callback: () => void) {
    window.addEventListener(VIEW_MODES_EVENT, callback);
    window.addEventListener("storage", callback);
    return () => {
        window.removeEventListener(VIEW_MODES_EVENT, callback);
        window.removeEventListener("storage", callback);
    };
}

/** 存到本機並廣播（各頁與偏好設定即時同步）；`persist` = 也存到帳號。/ Store locally and broadcast; `persist` also saves it on the account. */
export function storeViewModes(modes: ViewModes, persist: boolean) {
    try {
        localStorage.setItem(VIEW_MODES_KEY, JSON.stringify(modes));
    } catch {
        /* 私密模式等寫不進去：這次就不記在本機。/ Storage blocked: not cached this time. */
    }
    window.dispatchEvent(new Event(VIEW_MODES_EVENT));
    if (persist) persistUserSetting({ view_modes: modes });
}
