"use client";

/**
 * 頁面目前的兩指縮放（visualViewport）。`enabled` 為 false 時不聽，回傳 null。
 * The page's current pinch zoom (visualViewport). Not listening, and null, while `enabled` is false.
 */
import { useEffect, useState } from "react";
import type { VisualViewportBox } from "@/lib/pageZoom";

export function useVisualZoom(enabled: boolean): VisualViewportBox | null {
    const [box, setBox] = useState<VisualViewportBox | null>(null);
    useEffect(() => {
        const vv = typeof window !== "undefined" ? window.visualViewport : null;
        if (!enabled || !vv) return;
        const update = () => setBox({ scale: vv.scale, offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop, width: vv.width });
        const first = requestAnimationFrame(update);
        vv.addEventListener("resize", update);
        vv.addEventListener("scroll", update);
        return () => {
            cancelAnimationFrame(first);
            vv.removeEventListener("resize", update);
            vv.removeEventListener("scroll", update);
        };
    }, [enabled]);
    return enabled ? box : null;
}
