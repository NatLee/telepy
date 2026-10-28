/**
 * 網路頁「最近用過的主機」：打開面板、開終端機（這裡或終端機頁）都算，存在這個瀏覽器的 localStorage
 * `telepy.lanRecent`（只記 id，不記名稱或位址）。
 * The network page's recently used hosts: opening the panel or a terminal (here or on the terminal page) counts.
 * Kept in this browser's localStorage `telepy.lanRecent` (ids only, no names or addresses).
 */
import { useCallback, useSyncExternalStore } from "react";
import { parseRecent, pushRecent, RECENT_KEY, type RecentHost } from "@/lib/lanHosts";

const EVENT = "telepy:lan-recent";
const EMPTY: RecentHost[] = [];
// 同一個字串回同一個陣列（useSyncExternalStore 要穩定的快照）。/ The same string yields the same array (a stable snapshot).
let cache: { raw: string | null; list: RecentHost[] } = { raw: null, list: EMPTY };

function snapshot(): RecentHost[] {
    let raw: string | null = null;
    try {
        raw = localStorage.getItem(RECENT_KEY);
    } catch { /* 不可用 / unavailable */ }
    if (raw !== cache.raw) cache = { raw, list: parseRecent(raw) };
    return cache.list;
}

function subscribe(cb: () => void) {
    window.addEventListener(EVENT, cb);
    window.addEventListener("storage", cb);
    return () => {
        window.removeEventListener(EVENT, cb);
        window.removeEventListener("storage", cb);
    };
}

function write(list: RecentHost[] | null) {
    try {
        if (list) localStorage.setItem(RECENT_KEY, JSON.stringify(list));
        else localStorage.removeItem(RECENT_KEY);
    } catch { /* 不可用 / unavailable */ }
    window.dispatchEvent(new Event(EVENT));
}

export function useRecentLanHosts() {
    // SSR 是空的，hydration 後讀實際值。/ Empty on the server, the stored list after hydration.
    const recent = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
    // 從存的值開始（另一個分頁可能剛更新過）。/ Start from storage (another tab may have just changed it).
    const remember = useCallback((tunnelId: number, hostId: number) => write(pushRecent(snapshot(), tunnelId, hostId, Date.now())), []);
    const clear = useCallback(() => write(null), []);
    return { recent, remember, clear };
}
