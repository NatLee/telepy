"use client";

import type React from "react";
import { useLayoutEffect, useState } from "react";

/** 元素寬度 ≥ `rem` 個根字級（跟著顯示大小）；畫面出現前就量好，不會先閃一下。/ Element width ≥ `rem` root font sizes; measured before paint. */
export function useWiderThan(ref: React.RefObject<HTMLElement | null>, rem: number): boolean {
    const [wider, setWider] = useState(false);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const measure = () => {
            const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
            setWider(el.clientWidth >= rem * root);
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref, rem]);
    return wider;
}
