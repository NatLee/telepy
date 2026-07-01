"use client";

import { useEffect, useState } from "react";

/**
 * 回傳指定 media query 是否符合。首次渲染（SSR / 尚未量測）回傳 undefined，量測後才是 true/false。
 * 這讓呼叫端可在「尚未量測」時先不渲染任何一邊，避免在 SSR 預設值與實際斷點不同而先掛載錯的一邊
 * （對會開 WebSocket/SSH 的元件尤其重要——避免多開一條又立刻關閉）。
 *
 * Returns whether the media query matches. Yields `undefined` on the first render (SSR / not yet
 * measured) and true/false afterwards, so callers can render nothing until measured — avoiding
 * mounting the wrong side (and, for components that open a WebSocket/SSH, opening an extra connection
 * only to immediately tear it down).
 */
export function useMediaQuery(query: string): boolean | undefined {
    const [matches, setMatches] = useState<boolean | undefined>(undefined);

    useEffect(() => {
        const mql = window.matchMedia(query);
        const update = () => setMatches(mql.matches);
        update();
        mql.addEventListener("change", update);
        return () => mql.removeEventListener("change", update);
    }, [query]);

    return matches;
}
