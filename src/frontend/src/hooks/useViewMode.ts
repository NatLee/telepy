/**
 * 各頁的卡片 / 清單顯示（跟著帳號走，見 lib/viewModes.ts）。`useViewModes()` 給全部（偏好設定用），
 * `useViewMode(page)` 給一頁。改了就存到本機快取並上傳帳號，開著的頁面與偏好設定即時同步。
 * Card / list view per page (it follows the account, see lib/viewModes.ts). `useViewModes()` returns every page
 * (Preferences), `useViewMode(page)` one page. A change goes to the local cache and the account, and open pages
 * and Preferences follow it live.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { readViewModes, storeViewModes, subscribeViewModes, viewModesSnapshot } from "@/lib/viewModeStore";
import { viewModeOf, type ViewMode, type ViewModes, type ViewPage } from "@/lib/viewModes";

export function useViewModes(): [ViewModes, (page: ViewPage, mode: ViewMode) => void] {
    const snap = useSyncExternalStore(subscribeViewModes, viewModesSnapshot, () => "");
    const modes = useMemo(() => (snap ? readViewModes() : {}), [snap]);
    const set = useCallback((page: ViewPage, mode: ViewMode) => storeViewModes({ ...readViewModes(), [page]: mode }, true), []);
    return [modes, set];
}

export function useViewMode(page: ViewPage): [ViewMode, (mode: ViewMode) => void] {
    const [modes, set] = useViewModes();
    return [viewModeOf(modes, page), (mode: ViewMode) => set(page, mode)];
}
