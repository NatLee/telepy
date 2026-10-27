/**
 * 各頁的「卡片 / 清單」顯示：跟著帳號走（`/api/user/settings` 的 `view_modes`），本機 localStorage `telepy.viewModes`
 * 只是快取，讓頁面第一次繪製就用對的版面。登入時以伺服器為準（`UserSettingsSync`）；伺服器還是空的就把本機的
 * （含舊版通道頁的 `tunnels-view`）傳上去。偏好設定 → 一般裡可以一次看到 / 改所有頁面。純函式在前半，有測試。
 * Card / list view per page: it follows the account (`view_modes` in `/api/user/settings`); localStorage
 * `telepy.viewModes` is only a cache so the first paint already uses the right layout. At sign-in the server wins
 * (`UserSettingsSync`); while the server has nothing the local choices (including the old tunnels page's
 * `tunnels-view`) are uploaded. Preferences → General shows and changes every page. Pure helpers first, tested.
 */
import type { TranslationKey } from "../locales/en";

export type ViewMode = "card" | "list";
export type ViewModes = Record<string, ViewMode>;

/** 有卡片 / 清單切換的頁面（偏好設定照這個順序列出）。/ Pages with a card / list switch (listed in this order in Preferences). */
export const VIEW_PAGES = [
    { id: "tunnels", label: "prefs.view.tunnels", fallback: "card" },
    { id: "key_groups", label: "prefs.view.keyGroups", fallback: "card" },
] as const satisfies readonly { id: string; label: TranslationKey; fallback: ViewMode }[];
export type ViewPage = (typeof VIEW_PAGES)[number]["id"];

export const VIEW_MODES_KEY = "telepy.viewModes";
/** 舊版通道頁自己的 key（只在搬家時讀一次）。/ The old tunnels page's own key (read once when migrating). */
export const LEGACY_TUNNELS_VIEW_KEY = "tunnels-view";
export const VIEW_MODES_EVENT = "telepy:view-modes";

export function isViewMode(v: unknown): v is ViewMode {
    return v === "card" || v === "list";
}

/** 不認得的值丟掉；頁面 id 形狀跟後端一樣（小寫、數字、底線，≤ 32）。/ Drops unknown values; page ids shaped like the backend's. */
export function parseViewModes(v: unknown): ViewModes {
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: ViewModes = {};
    for (const [page, mode] of Object.entries(v as Record<string, unknown>)) {
        if (/^[a-z0-9_]{1,32}$/.test(page) && isViewMode(mode)) out[page] = mode;
    }
    return out;
}

/** 這一頁要用哪種（沒選過用頁面的預設）。/ The mode for a page (its default when never chosen). */
export function viewModeOf(modes: ViewModes, page: ViewPage): ViewMode {
    return modes[page] ?? VIEW_PAGES.find((p) => p.id === page)!.fallback;
}

/** 本機快取 + 舊版通道頁的值（新的優先）。/ The local cache plus the old tunnels page's value (the cache wins). */
export function localViewModes(cached: string | null, legacyTunnels: string | null): ViewModes {
    let parsed: unknown = null;
    try {
        parsed = cached ? JSON.parse(cached) : null;
    } catch {
        parsed = null;
    }
    const modes = parseViewModes(parsed);
    if (modes.tunnels === undefined && isViewMode(legacyTunnels)) modes.tunnels = legacyTunnels;
    return modes;
}
