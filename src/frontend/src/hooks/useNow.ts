"use client";

/** 每 `ms` 毫秒更新一次的「現在」（相對時間的顯示用；render 裡不能直接叫 Date.now）。/ A ticking "now" for relative times. */
import { useEffect, useState } from "react";

export function useNow(ms: number): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), ms);
        return () => clearInterval(id);
    }, [ms]);
    return now;
}
