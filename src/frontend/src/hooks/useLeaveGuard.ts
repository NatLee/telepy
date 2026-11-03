/**
 * 關掉分頁 / 視窗（或重新整理）前問一聲。裝成 app 之後 Ctrl+W 在終端機裡是「刪前一個字」，焦點不在終端機時卻會關掉整個
 * app 視窗——斷線就結束的 shell 會跟著沒了。`active()` 在離開那一刻才問，所以不用每次狀態變動都重掛。
 * Ask before the tab / window closes (or reloads). Installed as an app, Ctrl+W deletes a word inside the terminal but
 * closes the whole app window when the focus is elsewhere — and shells that end on disconnect go with it. `active()`
 * is asked at that moment, so the listener needn't follow every state change.
 */
import { useEffect, useRef } from "react";

export function useLeaveGuard(active: () => boolean) {
    const ref = useRef(active);
    useEffect(() => {
        ref.current = active;
    });
    useEffect(() => {
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            if (!ref.current()) return;
            e.preventDefault();
            // 舊瀏覽器要 returnValue；文字瀏覽器不顯示。/ Older browsers need returnValue; its text is not shown.
            e.returnValue = "";
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, []);
}
